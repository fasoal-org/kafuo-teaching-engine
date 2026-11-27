/**
 * The free rule fixes of a blocking plan (package-planner-issue-resolve-plan-2026-11-22
 * §3b step 1, owner 22 Nov 2026; implementation prompt P1 items 2–3): what a rule
 * can fix without a model call, run on the candidate before the book repair.
 *
 * 1. `TEACHING_STAGE_MISMATCH`: when the slide's `teachingStage.key` names exactly
 *    one flow position, its `flowIndex` is set to it. A key naming zero or several
 *    positions (a flow may repeat a stage) is left for the plan review layer (P2).
 * 2. `FLOW_SEQUENCE_INVALID`: once every slide carries a valid stage, each slide
 *    outside the longest in-order run is moved to the place the flow dictates
 *    ({@link locateFlowOrderProblems}, the one authority the admin's explainer
 *    mirrors), one move at a time.
 *
 * `POSITION_CARDINALITY` is not handled here (P2 picks which extras go) and
 * `NO_OUTLINES` is re-planned by the caller. Each step is kept only when its
 * re-diagnosis adds no new finding code (the E-3 accept of `repairBookCoverageGaps`);
 * otherwise the whole step rolls back and none of its fixes is recorded. Nothing
 * here mutates its input or logs lesson text: counts and codes only.
 */
import type { OutlineDiagnostic } from '@openmaic/generation';

import { createLogger } from '@/lib/logger';
import { orderedScenes } from '@/lib/server/teaching-package/content-unit-coverage';
import {
  applyCorrectionOperations,
  type CorrectionEditContext,
  type CorrectionOperation,
} from '@/lib/server/teaching-package/outline-correction';
import {
  PLAN_REVIEWER_ACTOR,
  type PlanFixDraft,
} from '@/lib/server/teaching-package/plan-fix-records';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';
import type {
  GenerationCheckpointSourceRefs,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

const log = createLogger('PlanAutoFixes');

/** One rule fix before it is recorded (no id, run or time yet). */
export type PlanFixEntry = PlanFixDraft;

const TEACHING_STAGE_MISMATCH = 'TEACHING_STAGE_MISMATCH';
const FLOW_SEQUENCE_INVALID = 'FLOW_SEQUENCE_INVALID';

/**
 * `teachingFlowDiagnostics` checks the order only once EVERY slide's stage is valid,
 * so a plan with a stage mismatch could not report it. When step 1 makes the stages
 * valid an order issue may appear for the first time: it was hidden, not added, and
 * step 2 moves the slide, so step 1 is not rolled back for it. Every other code step 1
 * brings out still rolls it back — a `POSITION_CARDINALITY` too (the key put the slide
 * into a one-slide stage that already has one: the key, not the slide, is likely
 * wrong, and P2 may otherwise delete a slide for it), as does a stage policy finding
 * on the fixed slide.
 */
const STAGE_FIX_EXEMPT_CODES: ReadonlySet<string> = new Set([FLOW_SEQUENCE_INVALID]);
const NO_EXEMPT_CODES: ReadonlySet<string> = new Set();

const REASON = {
  stage: 'تصحيح رقم مرحلة الشريحة علشان يطابق اسم مرحلتها في تدفق التدريس',
  move: 'نقل الشريحة لمكانها حسب ترتيب مراحل التدريس',
} as const;

// ---------------------------------------------------------------------------
// Where the order breaks (ported from the admin's correctionFlowOrder.ts, 14 Nov)
// ---------------------------------------------------------------------------

export interface MisplacedOutline {
  outlineId: string;
  /** The slide's flow position (0-based, as stored on its `teachingStage`). */
  flowIndex: number;
  /** Its index in the list now. */
  fromIndex: number;
  /** The 0-based `toIndex` a `move` takes: the list without the slide, then inserted. */
  toIndex: number;
  /**
   * Why it is out of place: it comes `after` slides of a later stage, or `before`
   * slides of an earlier one (`flowIndex` of that stage). The admin's explainer reads it.
   */
  conflict: { kind: 'after' | 'before'; flowIndex: number } | null;
}

export interface FlowOrderProblems {
  misplaced: MisplacedOutline[];
  /** Flow positions no slide covers. */
  missing: number[];
}

function stageOf(outline: SceneOutline | undefined): number | null {
  const flowIndex = outline?.teachingStage?.flowIndex;
  return Number.isInteger(flowIndex) ? (flowIndex as number) : null;
}

/**
 * Which slides break the stage order, and where each belongs. The slides outside
 * the longest run already in stage order (non-decreasing) are the misplaced ones
 * (the fewest moves that fix the order); each goes right after the last in-order
 * slide of its stage or an earlier one. A slide without a stage is neither
 * misplaced nor counted as covering a position. The same answer, tie-breaks
 * included, as the admin's `locateFlowOrderProblems`.
 */
export function locateFlowOrderProblems(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
): FlowOrderProblems {
  // Indexes into `outlines` of the slides that carry a stage, and their stages.
  const staged = outlines.flatMap((outline, index) => (stageOf(outline) === null ? [] : [index]));
  const stages = staged.map((index) => stageOf(outlines[index])!);

  // The longest run already in stage order; everything else is misplaced.
  const length = stages.map(() => 1);
  const previous = stages.map(() => -1);
  for (let i = 0; i < stages.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (stages[j]! <= stages[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1;
        previous[i] = j;
      }
    }
  }
  let end = -1;
  for (let i = 0; i < stages.length; i += 1) {
    if (end === -1 || length[i]! >= length[end]!) end = i;
  }
  const kept = new Set<number>();
  for (let i = end; i !== -1; i = previous[i]!) kept.add(staged[i]!);

  const misplaced = staged
    .filter((position) => !kept.has(position))
    .map((position): MisplacedOutline => {
      const flowIndex = stageOf(outlines[position])!;
      let latest = -1;
      let earliest = Infinity;
      // Its place: right after the last in-order slide of its stage or an earlier
      // one, counted in the list without the slide.
      let anchor = -1;
      for (const other of kept) {
        const stage = stageOf(outlines[other])!;
        if (other < position) latest = Math.max(latest, stage);
        else earliest = Math.min(earliest, stage);
        if (stage <= flowIndex) anchor = Math.max(anchor, other < position ? other : other - 1);
      }
      const conflict =
        latest > flowIndex
          ? { kind: 'after' as const, flowIndex: latest }
          : earliest < flowIndex
            ? { kind: 'before' as const, flowIndex: earliest }
            : null;
      return {
        outlineId: outlines[position]!.id,
        flowIndex,
        fromIndex: position,
        toIndex: anchor + 1,
        conflict,
      };
    });

  const covered = new Set(stages);
  const missing = flow.map((_, flowIndex) => flowIndex).filter((index) => !covered.has(index));
  return { misplaced, missing };
}

// ---------------------------------------------------------------------------
// The rule fixes
// ---------------------------------------------------------------------------

export interface PlanAutoFixContext {
  flow: readonly TeachingFlowEntry[];
  /**
   * Re-diagnose a candidate: the (normalised) outlines and every OPEN blocking
   * diagnostic, under the same ignore filter as the `blocking` passed in (an
   * issue a person ignored would otherwise look like a new code).
   */
  diagnose: (candidate: SceneOutline[]) => {
    outlines: SceneOutline[];
    blocking: OutlineDiagnostic[];
  };
}

export interface PlanAutoFixResult {
  outlines: SceneOutline[];
  blocking: OutlineDiagnostic[];
  /** The kept fixes, in the order they were applied (an undo runs them backwards). */
  fixes: PlanFixDraft[];
}

/**
 * The edit context of the rule operations. `move` and `set teachingStage` read only
 * the flow; the source refs (Content Unit and visual checks of other fields) are
 * never read, so an empty pair stands in for them.
 */
function ruleEditContext(flow: readonly TeachingFlowEntry[]): CorrectionEditContext {
  return {
    phase: 'outline',
    flow,
    sourceRefs: {
      contentUnitIds: null,
      sourceImages: [],
    } as unknown as GenerationCheckpointSourceRefs,
    pendingOutlineIds: null,
  };
}

/** The candidate after the operations, or `null` when one is refused (the step is skipped). */
function applyRuleOperations(
  outlines: readonly SceneOutline[],
  operations: readonly CorrectionOperation[],
  flow: readonly TeachingFlowEntry[],
): SceneOutline[] | null {
  try {
    return applyCorrectionOperations(outlines, operations, ruleEditContext(flow));
  } catch {
    log.warn(`plan auto-fixes: ${operations.length} rule operation(s) refused; step skipped`);
    return null;
  }
}

function hasValidStage(outline: SceneOutline, flow: readonly TeachingFlowEntry[]): boolean {
  const position = outline.teachingStage;
  return (
    position !== undefined &&
    Number.isInteger(position.flowIndex) &&
    position.flowIndex >= 0 &&
    position.flowIndex < flow.length &&
    flow[position.flowIndex]!.stage === position.key
  );
}

/** Step 1: the stage mismatches whose key names exactly one flow position. */
function stageKeyFixes(
  outlines: readonly SceneOutline[],
  open: readonly OutlineDiagnostic[],
  flow: readonly TeachingFlowEntry[],
): { outlines: SceneOutline[]; fixes: PlanFixDraft[] } | null {
  const ids = new Set(
    open
      .filter((issue) => issue.code === TEACHING_STAGE_MISMATCH && issue.outlineId)
      .map((issue) => issue.outlineId!),
  );
  const operations: CorrectionOperation[] = [];
  const fixes: PlanFixDraft[] = [];
  for (const id of ids) {
    const position = outlines.find((outline) => outline.id === id)?.teachingStage;
    if (!position || typeof position.key !== 'string') continue;
    if (flow[position.flowIndex]?.stage === position.key) continue;
    const named = flow.flatMap((entry, index) => (entry.stage === position.key ? [index] : []));
    // Zero or several positions: which one is meant is the review layer's call (P2).
    if (named.length !== 1) continue;
    const flowIndex = named[0]!;
    operations.push({ op: 'set', outlineId: id, field: 'teachingStage', value: flowIndex });
    fixes.push({
      op: 'set',
      outlineId: id,
      field: 'teachingStage',
      from: { key: position.key, flowIndex: position.flowIndex },
      to: { key: flow[flowIndex]!.stage, flowIndex },
      reason: REASON.stage,
      actor: PLAN_REVIEWER_ACTOR,
      round: 0,
    });
  }
  if (operations.length === 0) return null;
  const edited = applyRuleOperations(outlines, operations, flow);
  return edited ? { outlines: edited, fixes } : null;
}

/**
 * Step 2: move each misplaced slide to its flow place, recomputing after every
 * move so the next index is read from the list as it now is. Each record holds
 * the slide's index before that move (`from`) and right after it (`to`).
 */
function flowOrderMoves(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
): { outlines: SceneOutline[]; fixes: PlanFixDraft[] } | null {
  let next = [...outlines];
  const fixes: PlanFixDraft[] = [];
  // Every move lengthens the in-order run by at least one, so this bound is never reached.
  for (let guard = 0; guard < outlines.length; guard += 1) {
    const [first] = locateFlowOrderProblems(next, flow).misplaced;
    if (!first) break;
    const moved = applyRuleOperations(
      next,
      [{ op: 'move', outlineId: first.outlineId, toIndex: first.toIndex }],
      flow,
    );
    if (!moved) return null;
    next = moved;
    fixes.push({
      op: 'move',
      outlineId: first.outlineId,
      from: first.fromIndex,
      to: first.toIndex,
      reason: REASON.move,
      actor: PLAN_REVIEWER_ACTOR,
      round: 0,
    });
  }
  return fixes.length > 0 ? { outlines: next, fixes } : null;
}

/**
 * Apply the free rule fixes to a blocking candidate (§3b step 1). Returns the
 * candidate unchanged with `fixes: []`, without a single diagnosis, when no fix
 * applies. Otherwise each step is re-diagnosed and kept only when it adds no new
 * finding code over the codes open before it.
 */
export function applyPlanAutoFixes(
  outlines: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  context: PlanAutoFixContext,
): PlanAutoFixResult {
  let current: SceneOutline[] = [...outlines];
  let open: OutlineDiagnostic[] = [...blocking];
  const fixes: PlanFixDraft[] = [];
  const ids = outlines.map((outline) => outline.id);
  // A fix is recorded, applied and undone by slide id: a plan without unique ids is left as it is.
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) {
    return { outlines: current, blocking: open, fixes };
  }

  const accept = (
    step: string,
    candidate: { outlines: SceneOutline[]; fixes: PlanFixDraft[] },
    exempt: ReadonlySet<string>,
  ) => {
    const before = new Set(open.map((issue) => issue.code));
    const diagnosed = context.diagnose(candidate.outlines);
    const added = [
      ...new Set(
        diagnosed.blocking
          .map((issue) => issue.code)
          .filter((code) => !before.has(code) && !exempt.has(code)),
      ),
    ];
    if (added.length > 0) {
      log.info(
        `plan auto-fixes: ${candidate.fixes.length} ${step} fix(es) rolled back (new codes: ${added.join(', ')})`,
      );
      return;
    }
    current = diagnosed.outlines;
    open = diagnosed.blocking;
    fixes.push(...candidate.fixes);
    log.info(
      `plan auto-fixes: ${candidate.fixes.length} ${step} fix(es) kept, ${open.length} issue(s) open`,
    );
  };

  const staged = stageKeyFixes(current, open, context.flow);
  if (staged) accept('stage', staged, STAGE_FIX_EXEMPT_CODES);

  if (
    open.some((issue) => issue.code === FLOW_SEQUENCE_INVALID) &&
    current.every((outline) => hasValidStage(outline, context.flow))
  ) {
    const moved = flowOrderMoves(current, context.flow);
    if (moved) accept('order', moved, NO_EXEMPT_CODES);
  }

  // The exemption holds only when step 2 cleared what step 1 uncovered: an order
  // issue the input did not have, still open at the end, is a new finding, so the
  // stage fixes (and any move) roll back and the mismatch stays for P2 or a person.
  // E.g. a key that puts a slide into a stage that already has its slide, leaving
  // another stage with none: no move can fix that, and the key was likely wrong.
  const inputCodes = new Set(blocking.map((issue) => issue.code));
  if (
    fixes.length > 0 &&
    !inputCodes.has(FLOW_SEQUENCE_INVALID) &&
    open.some((issue) => issue.code === FLOW_SEQUENCE_INVALID)
  ) {
    log.info(
      `plan auto-fixes: ${fixes.length} fix(es) rolled back (the order issue the stage fixes uncovered stayed open)`,
    );
    return { outlines: [...outlines], blocking: [...blocking], fixes: [] };
  }

  return { outlines: current, blocking: open, fixes };
}

/**
 * Owner, 26 Nov 2026: what is actually wrong with a lesson's order, for the teacher —
 * the slides out of place (`misplacedSceneIds`, the fewest moves that fix the order)
 * and the flow positions no scene holds any more (`missing`, each with the slide it
 * belongs after, e.g. a deleted check quiz), instead of every slide of the lesson.
 * Shared by an insertion refusal and Submit's flow refusal (ED-1); it lives beside
 * {@link locateFlowOrderProblems} so Submit never imports the insertion module.
 */
export function flowProblemDetails(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
  /** g5.v12 (A-32): dropped check-quiz positions, empty by design — never "missing". */
  droppedPositions?: ReadonlySet<number>,
): {
  misplacedSceneIds: string[];
  missing: Array<{ flowIndex: number; stage: string; afterSceneId: string | null }>;
} {
  const ordered = orderedScenes(scenes);
  const located = locateFlowOrderProblems(ordered as unknown as SceneOutline[], flow);
  const problems = droppedPositions?.size
    ? {
        ...located,
        missing: located.missing.filter((flowIndex) => !droppedPositions.has(flowIndex)),
      }
    : located;
  const misplacedSceneIds = problems.misplaced.map((entry) => entry.outlineId);
  const misplaced = new Set(misplacedSceneIds);
  // The slide a missing page belongs after: the last slide IN PLACE before it (a
  // slide dragged out of place never names the gap).
  const inPlace = ordered.filter((scene) => !misplaced.has(scene.id));
  return {
    misplacedSceneIds,
    missing: problems.missing.map((flowIndex) => ({
      flowIndex,
      stage: flow[flowIndex]?.stage ?? '',
      afterSceneId:
        [...inPlace]
          .reverse()
          .find((scene) => (scene.teachingStage?.flowIndex ?? Infinity) < flowIndex)?.id ?? null,
    })),
  };
}
