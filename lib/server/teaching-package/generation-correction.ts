/**
 * The admin-correction lifecycle of a generation attempt
 * (slide-classification-admin-correction-plan §3):
 *
 *   running ──pause──▶ awaiting_admin_correction ──resume──▶ queued ──▶ running …
 *                              │  ▲ edit (revision CAS)
 *                              └──abandon──▶ failed (ADMIN_CORRECTION_ABANDONED)
 *
 * Every transition runs under the learning item's advisory lock with the
 * attempt and checkpoint rows locked, and is a compare-and-set on the attempt
 * status (and, for edits and resumes, the checkpoint revision). So:
 *
 * - a pause can never overwrite an attempt that was reclaimed or finished;
 * - two administrators can never silently overwrite each other's edits;
 * - two concurrent resumes of one revision start exactly ONE worker — the
 *   loser of the race (or a replay) gets the attempt back with `resumed: false`;
 * - the in-flight unique index counts the paused status, so no second attempt
 *   for the item can be admitted while one waits for a person.
 *
 * A paused candidate is never bound: binding still requires `running`.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  applyCheckpointEdit,
  markCheckpointAbandoned,
  markCheckpointResumed,
  readCheckpoint,
  readCheckpointForUpdate,
  upsertCheckpointForPause,
} from '@/lib/persistence/generation-checkpoint';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import {
  markAttemptAbandoned,
  markAttemptAwaitingCorrection,
  readAttempt,
  readAttemptById,
  readAttemptForUpdate,
  requeueAttemptForResume,
} from '@/lib/persistence/teaching-package';
import { removeStageMediaDir } from '@/lib/server/classroom-storage';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { assertActorRef, itemLockKey } from '@/lib/server/teaching-package/lifecycle';
import {
  applyCorrectionOperations,
  buildCorrectionView,
  diagnoseCandidateOutlines,
  diagnosisContextFromCheckpoint,
  diagnosticKey,
  ignoredIssueKeys,
  isIgnorableIssue,
  isResolvedByResume,
  withoutIgnoredIssues,
  type CorrectionCandidate,
  type CorrectionOperation,
  type CorrectionView,
} from '@/lib/server/teaching-package/outline-correction';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import {
  checkpointPlanReviewStatus,
  MAX_PLAN_FIXES,
  PLAN_REVIEWER_ACTOR,
  planFixesOf,
  recordedPlanFixes,
  revertedFixIds,
  revertPlanFix,
  withoutPlanFixIds,
  withPlanFixes,
  type PlanFixDraft,
  type PlanReviewStatus,
  type StoredPlanReview,
} from '@/lib/server/teaching-package/plan-fix-records';
import { applyPlanAutoFixes } from '@/lib/server/teaching-package/plan-auto-fixes';
import { PLAN_REVIEW_PROMPT_VERSION, reviewPlan } from '@/lib/server/teaching-package/plan-review';
import { createPlanReviewAiCall } from '@/lib/server/teaching-package/routed-plan-review-call';
import { createLogger } from '@/lib/logger';
import type { AICallFn, OutlineDiagnostic } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointSourceRefs,
  LearningItemRef,
  PlanReviewFix,
  TeachingFlowEntry,
  TeachingPackageAggregateKey,
} from '@/lib/types/teaching-package';

/** The actor recorded for a pause the runner makes on its own. */
export const RUNNER_ACTOR_REF = 'system:generation-runner';
const REASON_MAX_LENGTH = 500;
const log = createLogger('GenerationCorrection');

const aggregateOf = (attempt: GenerationAttempt): TeachingPackageAggregateKey => ({
  tenantId: attempt.tenantId,
  learningItem: attempt.learningItem,
});

/** sha256 of the authoritative flow, pinned on the checkpoint. */
export function flowDigestOf(flow: readonly TeachingFlowEntry[]): string {
  return createHash('sha256').update(JSON.stringify(flow), 'utf8').digest('hex');
}

const flowOf = (attempt: GenerationAttempt): TeachingFlowEntry[] =>
  attempt.inputSnapshot.teachingFlow ?? [];

const isGoverned = (attempt: GenerationAttempt): boolean => attempt.teachingSkillsContract !== null;

async function lockAttempt(
  tx: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<GenerationAttempt> {
  const peek = await readAttempt(tx, attemptId, scope);
  if (!peek)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    itemLockKey(aggregateOf(peek)),
  ]);
  const locked = await readAttemptForUpdate(tx, attemptId, scope);
  if (!locked)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  return locked;
}

/**
 * Read-modify-write of the attempt snapshot's `planReview` (P3 review HIGH 1), on the
 * raw stored snapshot: the parsed attempt strips the fixes' values, which the undo of a
 * resumed run's fixes still needs. `patch` returning its input writes nothing; returning
 * `undefined` drops the key. Called inside a transaction that holds the attempt lock.
 */
async function patchSnapshotPlanReview(
  tx: Queryable,
  attemptId: string,
  scope: { tenantId: string },
  patch: (planReview: StoredPlanReview | undefined) => StoredPlanReview | undefined,
): Promise<void> {
  const current = await tx.query<{ input_snapshot: Record<string, unknown> | null }>(
    `SELECT input_snapshot FROM teaching_package_generation_attempts
      WHERE id = $1 AND tenant_id = $2`,
    [attemptId, scope.tenantId],
  );
  const snapshot = current.rows[0]?.input_snapshot;
  if (!snapshot) return;
  const { planReview: previous, ...rest } = snapshot;
  const next = patch(previous as StoredPlanReview | undefined);
  if (next === previous) return;
  await tx.query(
    `UPDATE teaching_package_generation_attempts
        SET input_snapshot = $3::jsonb
      WHERE id = $1 AND tenant_id = $2`,
    [attemptId, scope.tenantId, JSON.stringify(next ? { ...rest, planReview: next } : rest)],
  );
}

function notAwaiting(attempt: GenerationAttempt, checkpoint: GenerationCheckpoint | null): never {
  throw new TeachingPackageError(
    'CORRECTION_NOT_AWAITING',
    `generation attempt ${attempt.id} is not awaiting admin correction (status ${attempt.status})`,
    {
      attemptStatus: attempt.status,
      ...(checkpoint ? { checkpointState: checkpoint.state, revision: checkpoint.revision } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Pause (runner)
// ---------------------------------------------------------------------------

/**
 * Persist the checkpoint and move `running → awaiting_admin_correction` in ONE
 * transaction with the `generation_awaiting_correction` webhook. Returns
 * `paused: false` — and writes nothing — when the attempt is no longer
 * `running` (reclaimed or finished elsewhere).
 */
export async function pauseAttemptForCorrection(
  pool: ConnectableQueryable,
  attemptId: string,
  candidate: CorrectionCandidate,
  sourceRefs: GenerationCheckpointSourceRefs,
  /** The plan review's fixes since the run or resume began (§3b), kept on the pause entry. */
  planFixes: readonly PlanReviewFix[] = [],
): Promise<{ paused: boolean; checkpoint?: GenerationCheckpoint }> {
  const attempt = await readAttemptById(pool, attemptId);
  if (!attempt) return { paused: false };
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const locked = await lockAttempt(tx, attemptId, { tenantId: attempt.tenantId });
    if (locked.status !== 'running') return { paused: false };
    const now = Date.now();
    const checkpoint = await upsertCheckpointForPause(tx, {
      attemptId,
      tenantId: locked.tenantId,
      phase: candidate.phase,
      outlines: candidate.outlines,
      courseTitle: candidate.courseTitle,
      languageDirective: candidate.languageDirective,
      diagnostics: candidate.diagnostics,
      repairs: candidate.repairs,
      sourceRefs,
      reservedStageId: candidate.reservedStageId ?? null,
      pendingOutlineIds: candidate.pendingOutlineIds ?? null,
      actorRef: RUNNER_ACTOR_REF,
      now,
      planFixes,
    });
    const paused = await markAttemptAwaitingCorrection(tx, attemptId, {
      step: candidate.phase === 'outline' ? 'generating_outlines' : 'generating_scenes',
      progress: candidate.phase === 'outline' ? 30 : 90,
      message: `Needs admin correction: ${candidate.diagnostics.length} issue(s)`,
      scenesGenerated: 0,
      totalScenes: candidate.outlines.length,
    });
    if (!paused) return { paused: false };
    await enqueueWebhookEvent(
      tx,
      aggregateOf(paused),
      'teaching_package.generation_awaiting_correction',
      () => ({
        requestId: paused.requestId ?? '',
        attempt: {
          id: paused.id,
          kind: paused.kind,
          status: 'awaiting_admin_correction',
          versionId: paused.versionId,
          startedAt: paused.startedAt,
          pausedAt: now,
          generationRuns: paused.generationRuns,
        },
        correction: {
          phase: checkpoint.phase,
          revision: checkpoint.revision,
          blockingIssueCount: checkpoint.diagnostics.length,
        },
      }),
    );
    return { paused: true, checkpoint };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The administrator's view of a paused (or previously paused) attempt. */
export async function getGenerationCorrection(
  pool: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<CorrectionView> {
  const attempt = await readAttempt(pool, attemptId, scope);
  if (!attempt)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  const checkpoint = await readCheckpoint(pool, attemptId, scope);
  if (!checkpoint) notAwaiting(attempt, null);
  return buildCorrectionView(attempt, checkpoint, flowOf(attempt));
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditCorrectionCommand {
  tenantId: string;
  actorRef: string;
  expectedRevision: number;
  operations: CorrectionOperation[];
}

/**
 * Apply an administrator's operations to the paused candidate, revalidate it
 * with the run's own diagnosis, and store it as the next revision.
 */
export async function editGenerationCorrection(
  pool: ConnectableQueryable,
  attemptId: string,
  command: EditCorrectionCommand,
): Promise<CorrectionView> {
  const actorRef = assertActorRef(command.actorRef);
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (
      !checkpoint ||
      checkpoint.state !== 'awaiting' ||
      attempt.status !== 'awaiting_admin_correction'
    ) {
      notAwaiting(attempt, checkpoint);
    }
    if (checkpoint.revision !== command.expectedRevision) {
      throw new TeachingPackageError(
        'STALE_STATE',
        `the correction was edited since revision ${command.expectedRevision}; reload it`,
        { currentRevision: checkpoint.revision },
      );
    }
    // P3 (package-plan-review-p3-contract-2026-11-22): the plan review works on the
    // plan in the background; nothing else may change it meanwhile.
    const reviewStatus = checkpointPlanReviewStatus(checkpoint);
    if (reviewStatus === 'reviewing') {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the plan reviewer is working on this plan; reload it when it finishes',
        { currentRevision: checkpoint.revision },
      );
    }
    if (command.operations.some((operation) => operation.op === 'review_plan')) {
      return startPlanReview(tx, attempt, checkpoint, command, actorRef, reviewStatus);
    }
    const flow = flowOf(attempt);
    const diagnosisContext = diagnosisContextFromCheckpoint(
      checkpoint,
      flow,
      isGoverned(attempt),
      attempt.inputSnapshot.bookStructure,
      attempt.teachingModel,
      attempt.inputSnapshot.teacherGuide,
    );
    // P3: «تراجع» puts one recorded fix's before-state back, before any other op.
    const reverted = revertedFixIds(checkpoint.editLog);
    const recorded = new Map(planFixesOf(checkpoint.editLog).map((fix) => [fix.id, fix] as const));
    let base = checkpoint.outlines;
    const undoneNow = new Set<string>();
    for (const [index, operation] of command.operations.entries()) {
      if (operation.op !== 'revert_fix') continue;
      const fix = recorded.get(operation.fixId);
      if (!fix || reverted.has(operation.fixId) || checkpoint.phase !== 'outline') {
        throw new TeachingPackageError(
          'INVALID_REQUEST',
          `operations[${index}] undoes a fix that is not recorded on this plan, or was undone already`,
        );
      }
      const undone = revertPlanFix(base, fix);
      if (!undone) {
        throw new TeachingPackageError(
          'INVALID_REQUEST',
          `operations[${index}]: the plan no longer holds what this fix changed; reload the correction`,
        );
      }
      base = undone;
      reverted.add(operation.fixId);
      undoneNow.add(operation.fixId);
    }
    const edited = applyCorrectionOperations(base, command.operations, {
      phase: checkpoint.phase,
      flow,
      sourceRefs: checkpoint.sourceRefs,
      pendingOutlineIds: checkpoint.pendingOutlineIds,
      // The same book map the diagnosis checks, so an inserted slide answers
      // exactly the gap the diagnosis reports.
      ...(diagnosisContext.bookStructure ? { bookStructure: diagnosisContext.bookStructure } : {}),
    });
    // An ignore names an issue that is open now; it is never a blank waiver.
    // A structure/order issue cannot be ignored: the run would only fail later.
    const open = new Map(
      checkpoint.diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic] as const),
    );
    const operations = command.operations.map((operation, index) => {
      if (operation.op !== 'ignore_issue') return operation;
      const issue = open.get(operation.issueKey);
      if (!issue) {
        throw new TeachingPackageError(
          'INVALID_REQUEST',
          `operations[${index}] ignores an issue that is not open; reload the correction`,
        );
      }
      if (!isIgnorableIssue(issue)) {
        throw new TeachingPackageError(
          'INVALID_REQUEST',
          `operations[${index}]: a ${issue.code} issue cannot be ignored; fix it with remove, move or the teaching stage`,
        );
      }
      // The wording at the time, for the record (the key leaves it out).
      return { op: 'ignore_issue' as const, issueKey: operation.issueKey, message: issue.message };
    });
    const ignored = ignoredIssueKeys(checkpoint.editLog, operations);
    const diagnosis = diagnoseCandidateOutlines(edited, diagnosisContext);
    diagnosis.blocking = withoutIgnoredIssues(diagnosis.blocking, ignored);
    const now = Date.now();
    const updated = await applyCheckpointEdit(tx, attemptId, {
      tenantId: command.tenantId,
      expectedRevision: command.expectedRevision,
      outlines: diagnosis.outlines,
      diagnostics: diagnosis.blocking,
      repairs: [...checkpoint.repairs, ...diagnosis.repairs],
      logEntry: {
        event: 'edited',
        actorRef,
        at: now,
        operations,
        blockingCount: diagnosis.blocking.length,
      },
      now,
    });
    if (!updated) {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the correction changed concurrently; reload it',
      );
    }
    // P3 review HIGH 1: an undone fix leaves the attempt record too, in this
    // transaction, so a completed attempt (its succeeded webhook) never lists it.
    if (undoneNow.size > 0) {
      await patchSnapshotPlanReview(tx, attemptId, { tenantId: command.tenantId }, (previous) =>
        withoutPlanFixIds(previous, undoneNow),
      );
    }
    return buildCorrectionView(attempt, updated, flow);
  });
}

/**
 * P3 (package-plan-review-p3-contract-2026-11-22): mark the review of a plan that
 * paused before the plan review existed as started, and return at once. The route
 * then runs it in the background (`runCheckpointPlanReview`), which stores the
 * reviewed plan as the next revision. Alone in its request; outline phase only;
 * once per checkpoint (a finished or running review refuses another).
 */
async function startPlanReview(
  tx: Queryable,
  attempt: GenerationAttempt,
  checkpoint: GenerationCheckpoint,
  command: EditCorrectionCommand,
  actorRef: string,
  status: PlanReviewStatus,
): Promise<CorrectionView> {
  if (command.operations.length !== 1) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'review_plan must be the only operation of its request',
    );
  }
  if (status !== 'not_reviewed' || checkpoint.phase !== 'outline') {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'the plan review already ran on this plan (or the plan is past its outline phase)',
    );
  }
  const now = Date.now();
  const updated = await applyCheckpointEdit(tx, attempt.id, {
    tenantId: command.tenantId,
    expectedRevision: command.expectedRevision,
    outlines: checkpoint.outlines,
    diagnostics: checkpoint.diagnostics,
    repairs: checkpoint.repairs,
    logEntry: {
      event: 'edited',
      actorRef,
      at: now,
      operations: [{ op: 'review_plan' }],
      blockingCount: checkpoint.diagnostics.length,
      planReview: 'started',
    },
    now,
  });
  if (!updated) {
    throw new TeachingPackageError('STALE_STATE', 'the correction changed concurrently; reload it');
  }
  return buildCorrectionView(attempt, updated, flowOf(attempt));
}

/**
 * P3 (package-plan-review-p3-contract-2026-11-22): the background half of
 * `review_plan`. The free rule fixes (P1) and the AI plan review (P2) run on the
 * paused plan, on the planning route frozen on the attempt, and the reviewed plan
 * is stored as the next revision with its fixes (`planReview: 'finished'`), and the
 * fixes are kept on the attempt snapshot like a run's own (§3), in one transaction.
 * A failed call ends the AI review and keeps only the rule fixes. Any other failure,
 * or nothing kept, still finishes the review, so the page leaves its busy state; the
 * plan is then as it was. The book repair is not run here: its planner needs the
 * lesson's unit text, which a checkpoint does not keep (the AI review's
 * `insert_book_slide` adds a missing book solution slide instead). Never throws: a
 * failure is logged with counts and codes only.
 */
export async function runCheckpointPlanReview(
  pool: ConnectableQueryable,
  attemptId: string,
  scope: { tenantId: string },
  deps: { aiCall?: AICallFn; now?: () => number } = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  // The checkpoint the review started from: every write is made against its revision.
  let started: GenerationCheckpoint | null = null;
  try {
    const attempt = await readAttempt(pool, attemptId, scope);
    const checkpoint = await readCheckpoint(pool, attemptId, scope);
    if (
      !attempt ||
      !checkpoint ||
      attempt.status !== 'awaiting_admin_correction' ||
      checkpointPlanReviewStatus(checkpoint, now()) !== 'reviewing'
    ) {
      return;
    }
    started = checkpoint;
    const flow = flowOf(attempt);
    const diagnosisContext = diagnosisContextFromCheckpoint(
      checkpoint,
      flow,
      isGoverned(attempt),
      attempt.inputSnapshot.bookStructure,
      attempt.teachingModel,
      attempt.inputSnapshot.teacherGuide,
    );
    const ignored = ignoredIssueKeys(checkpoint.editLog);
    // The machine repairs of each diagnosis, by the outlines it returned: the stored
    // plan is always the outlines of one kept diagnosis (never a rolled-back candidate).
    const repairsOf = new WeakMap<SceneOutline[], OutlineDiagnostic[]>();
    const diagnose = (candidate: SceneOutline[]) => {
      const diagnosis = diagnoseCandidateOutlines(candidate, diagnosisContext);
      repairsOf.set(diagnosis.outlines, diagnosis.repairs);
      return {
        outlines: diagnosis.outlines,
        blocking: withoutIgnoredIssues(diagnosis.blocking, ignored),
      };
    };
    const generationRun = checkpoint.sourceRefs.generationRun;
    // Diagnosed afresh, with today's rules, like an edit: an old pause's stored list
    // may predate a rule (or a fix) the review relies on.
    const initial = diagnose(checkpoint.outlines);
    let outlines = initial.outlines;
    let blocking = initial.blocking;
    const drafts: PlanFixDraft[] = [];
    let reviewerFixesKept = false;
    const ruled = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });
    if (ruled.fixes.length > 0) {
      outlines = ruled.outlines;
      blocking = ruled.blocking;
      drafts.push(...ruled.fixes);
    }
    if (blocking.length > 0) {
      // The route is resolved by the first call: a route failure ends the AI review
      // (`endedOnError`) and the rule fixes above are still kept.
      const aiCall = deps.aiCall ?? createPlanReviewAiCall({ attempt, generationRun });
      const book = diagnosisContext.bookStructure;
      const units = checkpoint.sourceRefs.contentUnits ?? [];
      const reviewed = await reviewPlan(outlines, blocking, aiCall, {
        phase: 'outline',
        flow,
        // A checkpoint keeps the units' ids, roles and titles, never their text.
        units: units.map((unit) => ({
          id: String(unit.id),
          role: unit.role,
          element:
            book?.units.find((entry) => String(entry.contentUnitId) === String(unit.id))?.element ??
            null,
          title: unit.title,
          text: '',
        })),
        requiredUnitIds: (book?.units ?? [])
          .filter((unit) => unit.required)
          .map((unit) => String(unit.contentUnitId)),
        essentialUnitIds: (checkpoint.sourceRefs.essentialContentUnitIds ?? []).map(String),
        bookSummary: book
          ? book.units
              .map(
                (unit) =>
                  `${unit.contentUnitId}: ${unit.element}${unit.required ? ' (required)' : ''}`,
              )
              .join('\n')
          : null,
        language:
          typeof attempt.inputSnapshot.generationContext?.language === 'string'
            ? attempt.inputSnapshot.generationContext.language
            : 'ar-SA',
        languageDirective: checkpoint.languageDirective,
        // Only the prompt's policy text (S-9); it guards nothing by itself.
        sacredMode: 'full',
        // A checkpoint keeps no unit text and no run quotes, so a new working step
        // could be neither grounded nor checked for verses: no `set keyPoints` here.
        allowKeyPoints: false,
        diagnose,
        editContext: {
          phase: 'outline',
          flow,
          sourceRefs: checkpoint.sourceRefs,
          pendingOutlineIds: null,
          ...(book ? { bookStructure: book } : {}),
        },
      });
      // A failed call (its route included) keeps nothing of the AI review: neither a
      // round kept before it nor the step 7 fallback, as a routed run that fails on
      // its route keeps none of it. The rule fixes stay.
      if (reviewed.endedOnError) {
        log.warn(
          `Plan review of paused attempt ${attemptId}: the AI review call failed; only the ${drafts.length} rule fix(es) are kept`,
        );
      } else if (reviewed.fixes.length > 0) {
        outlines = reviewed.outlines;
        blocking = reviewed.blocking;
        drafts.push(...reviewed.fixes);
        reviewerFixesKept = true;
      }
    }
    // Like an edit: the checkpoint's repairs, then this review's (the fresh diagnosis
    // of the stored plan, and the kept diagnosis of the plan stored now).
    const repairs = [
      ...checkpoint.repairs,
      ...(repairsOf.get(initial.outlines) ?? []),
      ...(outlines !== initial.outlines ? (repairsOf.get(outlines) ?? []) : []),
    ];
    const at = now();
    const planFixes = recordedPlanFixes(drafts, generationRun, at).slice(-MAX_PLAN_FIXES);
    const withTransaction = nodePostgresTransaction(pool);
    const finished = await withTransaction(async (tx) => {
      // The same lock order as an edit (item lock, attempt, then checkpoint).
      await lockAttempt(tx, attemptId, scope);
      const stored = await applyCheckpointEdit(tx, attemptId, {
        tenantId: scope.tenantId,
        expectedRevision: checkpoint.revision,
        outlines,
        diagnostics: blocking,
        repairs,
        logEntry: {
          event: 'edited',
          actorRef: PLAN_REVIEWER_ACTOR,
          at,
          operations: [],
          blockingCount: blocking.length,
          planReview: 'finished',
          ...(planFixes.length > 0 ? { planFixes } : {}),
        },
        now: at,
      });
      // §3: the attempt record keeps the paused run's fixes, as the runner's own
      // `recordPlanFixes` does, so the succeeded webhook carries them after a resume.
      if (stored && planFixes.length > 0) {
        await patchSnapshotPlanReview(tx, attemptId, scope, (previous) => ({
          ...withPlanFixes(previous, planFixes, generationRun),
          ...(reviewerFixesKept
            ? { promptVersion: PLAN_REVIEW_PROMPT_VERSION }
            : previous?.promptVersion
              ? { promptVersion: previous.promptVersion }
              : {}),
        }));
      }
      return stored;
    });
    log.info(
      `Plan review of paused attempt ${attemptId}: ${planFixes.length} fix(es), ${blocking.length} issue(s) left${finished ? '' : ' (the correction moved meanwhile; not stored)'}`,
    );
  } catch (error) {
    log.warn(
      `Plan review of paused attempt ${attemptId} failed: ${error instanceof TeachingPackageError ? error.code : error instanceof Error ? error.name : 'unknown'}`,
    );
    // Finish the review with the plan unchanged, so the page leaves its busy state.
    if (started) {
      await finishPlanReviewUnchanged(pool, attemptId, scope, started, now()).catch(() => {});
    }
  }
}

/**
 * Finish a failed review with the plan as it was, against the revision the review
 * started from: when anything changed since (a newer review started after this one
 * went stale, an abandon), the write fails and nothing is touched.
 */
async function finishPlanReviewUnchanged(
  pool: Queryable,
  attemptId: string,
  scope: { tenantId: string },
  started: GenerationCheckpoint,
  at: number,
): Promise<void> {
  await applyCheckpointEdit(pool, attemptId, {
    tenantId: scope.tenantId,
    expectedRevision: started.revision,
    outlines: started.outlines,
    diagnostics: started.diagnostics,
    repairs: started.repairs,
    logEntry: {
      event: 'edited',
      actorRef: PLAN_REVIEWER_ACTOR,
      at,
      operations: [],
      blockingCount: started.diagnostics.length,
      planReview: 'finished',
    },
    now: at,
  });
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export interface ResumeCorrectionCommand {
  tenantId: string;
  actorRef: string;
  expectedRevision: number;
  /** Canonical digest of the re-sent request (fresh retrieval URLs, same semantics). */
  requestDigest: string;
  learningItem: LearningItemRef;
}

/**
 * `awaiting_admin_correction → queued` for the SAME attempt, after proving the
 * re-sent request is the attempt's own (canonical digest), the revision is the
 * one the administrator validated, and the candidate has no open issue. A
 * replay of an already-resumed revision returns the attempt with
 * `resumed: false` and must not start a worker.
 */
export async function resumeGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  command: ResumeCorrectionCommand,
): Promise<{ attempt: GenerationAttempt; resumed: boolean }> {
  const actorRef = assertActorRef(command.actorRef);
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    if (
      attempt.learningItem.type !== command.learningItem.type ||
      attempt.learningItem.id !== command.learningItem.id
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'the resume request names a different learning item than the attempt',
      );
    }
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (!checkpoint) notAwaiting(attempt, null);
    if (checkpoint.state === 'resumed' && checkpoint.resumedRevision === command.expectedRevision) {
      return { attempt, resumed: false };
    }
    if (checkpoint.state !== 'awaiting' || attempt.status !== 'awaiting_admin_correction') {
      notAwaiting(attempt, checkpoint);
    }
    if (checkpoint.revision !== command.expectedRevision) {
      throw new TeachingPackageError(
        'STALE_STATE',
        `the correction is at revision ${checkpoint.revision}, not ${command.expectedRevision}`,
        { currentRevision: checkpoint.revision },
      );
    }
    // P3: never while the plan review is working on the plan.
    if (checkpointPlanReviewStatus(checkpoint) === 'reviewing') {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the plan reviewer is working on this plan; reload it when it finishes',
        { currentRevision: checkpoint.revision },
      );
    }
    if (attempt.requestDigest === null || attempt.requestDigest !== command.requestDigest) {
      throw new TeachingPackageError(
        'CORRECTION_REQUEST_MISMATCH',
        'the re-sent generation request is not the request this attempt was started with',
      );
    }
    // Revalidate at the boundary — never trust stored diagnostics alone.
    const flow = flowOf(attempt);
    const diagnosis = diagnoseCandidateOutlines(
      checkpoint.outlines,
      diagnosisContextFromCheckpoint(
        checkpoint,
        flow,
        isGoverned(attempt),
        attempt.inputSnapshot.bookStructure,
        attempt.teachingModel,
        attempt.inputSnapshot.teacherGuide,
      ),
    );
    // A missing image / diagram teaching note is the TE's to write, not the
    // administrator's: the resumed run re-plans that slide's visual itself
    // (slide image plan D-1/D-3), so it never holds a resume back — an older
    // checkpoint saved before notes existed resumes like any other.
    // An issue a person ignored on this checkpoint no longer holds it back.
    // A missing book slide (outline phase) is the resumed run's too (owner, 22 Nov
    // 2026): it re-reads the book and the book repair writes the slide, or the run
    // pauses again with only that issue (`isResolvedByResume`).
    const blocking = withoutIgnoredIssues(
      diagnosis.blocking,
      ignoredIssueKeys(checkpoint.editLog),
    ).filter((issue) => !isResolvedByResume(issue, checkpoint.phase));
    if (blocking.length > 0) {
      throw new TeachingPackageError(
        'CORRECTION_INCOMPLETE',
        `${blocking.length} issue(s) still need correction before this attempt can resume`,
        { blockingIssues: blocking.slice(0, 20) },
      );
    }
    const now = Date.now();
    const marked = await markCheckpointResumed(tx, attemptId, {
      tenantId: command.tenantId,
      revision: checkpoint.revision,
      actorRef,
      now,
    });
    const requeued = marked
      ? await requeueAttemptForResume(tx, attemptId, now, {
          step: checkpoint.phase === 'outline' ? 'generating_outlines' : 'generating_scenes',
          progress: checkpoint.phase === 'outline' ? 30 : 90,
          message: 'Resuming after admin correction',
          scenesGenerated: 0,
          totalScenes: checkpoint.outlines.length,
        })
      : null;
    if (!requeued) {
      throw new TeachingPackageError('STALE_STATE', 'the attempt changed concurrently; reload it');
    }
    return { attempt: requeued, resumed: true };
  });
}

// ---------------------------------------------------------------------------
// Abandon
// ---------------------------------------------------------------------------

export interface AbandonCorrectionCommand {
  tenantId: string;
  actorRef: string;
  reason: string;
}

/**
 * Give up a paused candidate: the attempt fails with the retryable
 * `ADMIN_CORRECTION_ABANDONED` (so a new generation can be requested), a
 * retained Stage is compensated after the commit, and the failure webhook is
 * emitted. Idempotent on an already-abandoned attempt.
 */
export async function abandonGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  command: AbandonCorrectionCommand,
): Promise<{ attempt: GenerationAttempt; abandoned: boolean }> {
  const actorRef = assertActorRef(command.actorRef);
  const reason = command.reason?.trim() ?? '';
  if (!reason) {
    throw new TeachingPackageError(
      'REASON_REQUIRED',
      'a reason is required to abandon a correction',
    );
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `reason must be at most ${REASON_MAX_LENGTH} characters`,
    );
  }
  const withTransaction = nodePostgresTransaction(pool);
  const outcome = await withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    if (attempt.status === 'failed' && attempt.errorCode === 'ADMIN_CORRECTION_ABANDONED') {
      return { attempt, abandoned: false, stageId: null as string | null };
    }
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (
      !checkpoint ||
      checkpoint.state !== 'awaiting' ||
      attempt.status !== 'awaiting_admin_correction'
    ) {
      notAwaiting(attempt, checkpoint);
    }
    const now = Date.now();
    await markCheckpointAbandoned(tx, attemptId, {
      tenantId: command.tenantId,
      actorRef,
      reason,
      now,
    });
    const failed = await markAttemptAbandoned(tx, attemptId, {
      message: `abandoned by an administrator: ${reason}`,
      code: 'ADMIN_CORRECTION_ABANDONED',
      now,
    });
    if (!failed) throw new TeachingPackageError('STALE_STATE', 'the attempt changed concurrently');
    await enqueueWebhookEvent(
      tx,
      aggregateOf(failed),
      'teaching_package.generation_failed',
      () => ({
        requestId: failed.requestId ?? '',
        attempt: {
          id: failed.id,
          kind: failed.kind,
          status: 'failed',
          versionId: failed.versionId,
          producedStageId: failed.producedStageId,
          startedAt: failed.startedAt,
          completedAt: now,
          generationRuns: failed.generationRuns,
        },
        error: {
          code: 'ADMIN_CORRECTION_ABANDONED',
          message: `abandoned by an administrator: ${reason}`.slice(0, 500),
          retryable: true,
        },
      }),
    );
    return { attempt: failed, abandoned: true, stageId: checkpoint.reservedStageId };
  });
  // Irreversible filesystem work only after the commit: the retained Stage was
  // never bound, so the guard allows its tombstone.
  if (outcome.abandoned && outcome.stageId) {
    await tombstoneStageMeta(pool as Queryable, outcome.stageId).catch(() => {});
    await removeStageMediaDir(outcome.stageId).catch(() => {});
  }
  return { attempt: outcome.attempt, abandoned: outcome.abandoned };
}
