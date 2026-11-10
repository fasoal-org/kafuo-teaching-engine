/**
 * The package review job (ai-reviewer-layer plan §4.1, §4.2, §4.4, §4.6, §4.10).
 *
 *   sweep (boot + interval) → claim under a lease → load the book units and
 *   the bound Stage's Scenes (text only) → ONE reviewer call for the whole
 *   package → store the findings (`reviewed_at`) → the fix loop (Phase 3) →
 *   ONE terminal status + `teaching_package.review_completed`, in one
 *   transaction.
 *
 * It runs AFTER the binding, never inside the generation attempt: the fix
 * loop needs a bound draft, and a long review inside the attempt would race
 * the 30-minute stale reclaim and hold a generation slot.
 *
 * Every exit is terminal and emits the event — a missing route or key, a
 * version that moved on, a thrown error — so the Backend gate never waits on
 * a review that will not finish (`unavailable` + `errorCode`). A partial
 * review is never reported as passed.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readVersionById } from '@/lib/persistence/teaching-package';
import {
  runReviewerCall,
  type ReviewerCallResult,
} from '@/lib/server/teaching-model/reviewer-call';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  loadReviewBookUnits,
  reviewSlidesOf,
  type ReviewBookUnit,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  PACKAGE_QUIZ_CHECKS,
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SYSTEM,
  parseReviewerAnswer,
  renderBookBlock,
  renderSlidesBlock,
  type ReviewerAnswer,
} from '@/lib/server/teaching-package/package-review-prompt';
import {
  claimReview,
  finishReview,
  listClaimableReviewIds,
  renewReviewLease,
  saveReviewProgress,
  type PackageReview,
  type ReviewOutcome,
  type StoredFinding,
  type StoredFix,
} from '@/lib/server/teaching-package/package-review-store';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import type { AppScene } from '@/lib/types/stage';

const log = createLogger('PackageReview');

/** One reviewer call is bounded at 15 min; the lease covers it with margin and is renewed per step. */
export const REVIEW_LEASE_MS = 20 * 60 * 1000;
/** A review claimed this many times without finishing ends `unavailable`. */
export const MAX_REVIEW_RUN_ATTEMPTS = 3;
/** Ledger stage of the package reviewer's calls (the consumption report's `feature`). */
export const PACKAGE_REVIEW_STAGE = 'package-review';

export interface ReviewCallRequest {
  review: PackageReview;
  units: readonly ReviewBookUnit[];
  slides: readonly ReviewSlide[];
  /** Re-review: only these slides are judged; the rest are neighbours. */
  focusIds?: ReadonlySet<string>;
}

export interface ReviewCallAnswer {
  answer: ReviewerAnswer;
  call: Pick<ReviewerCallResult, 'provider' | 'modelString' | 'usage'>;
}

/** The fix loop's view of one claimed review (Phase 3 fills it). */
export interface FixLoopContext {
  pool: ConnectableQueryable;
  review: PackageReview;
  units: readonly ReviewBookUnit[];
  slides: readonly ReviewSlide[];
  scenes: readonly AppScene[];
  findings: StoredFinding[];
  /** Keep the lease while fixing; false → stop (another worker took over). */
  heartbeat: () => Promise<boolean>;
  callReviewer: (request: ReviewCallRequest) => Promise<ReviewCallAnswer>;
  recordProgress: (findings: StoredFinding[], fixes: StoredFix[]) => Promise<void>;
  now: () => number;
}

export interface FixLoopResult {
  findings: StoredFinding[];
  fixes: StoredFix[];
}

export type FixLoop = (context: FixLoopContext) => Promise<FixLoopResult>;

export interface PackageReviewDeps {
  pool?: ConnectableQueryable;
  now?: () => number;
  workerId?: string;
  /** Test seam: the reviewer call (production: `runReviewerCall`). */
  callReviewer?: (
    request: ReviewCallRequest & { pool: ConnectableQueryable },
  ) => Promise<ReviewCallAnswer>;
  /** Phase 3: regenerate and re-review. Absent → every finding goes to the teacher. */
  fixLoop?: FixLoop;
  loadScenes?: (pool: ConnectableQueryable, stageId: string) => Promise<AppScene[] | null>;
}

function documentStore(pool: ConnectableQueryable) {
  return createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as unknown as TransactionSource,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

async function loadLiveScenes(
  pool: ConnectableQueryable,
  stageId: string,
): Promise<AppScene[] | null> {
  const document = (await documentStore(pool).loadDocument(stageId)) as AppDocument | null;
  return document ? (document.scenes as AppScene[]) : null;
}

/** The production reviewer call for one package (or a re-review of some slides). */
export async function callPackageReviewer(
  request: ReviewCallRequest & { pool: ConnectableQueryable },
): Promise<ReviewCallAnswer> {
  const { review, slides, units, focusIds } = request;
  const slideIds = new Set(slides.map((slide) => slide.id));
  const quizIds = new Set(
    slides.filter((slide) => slide.sceneType === 'quiz').map((slide) => slide.id),
  );
  const call = await runReviewerCall({
    pool: request.pool,
    tenantId: review.tenantId,
    subjectCode: review.subjectCode ?? 'UNKNOWN',
    capability: 'package_review',
    stage: PACKAGE_REVIEW_STAGE,
    association: {
      kind: 'generation',
      generationAttemptId: review.attemptId,
      versionId: review.versionId,
      learningItemType: review.learningItem.type,
      learningItemId: review.learningItem.id,
      reviewId: review.id,
    },
    aggregate: { tenantId: review.tenantId, learningItem: review.learningItem },
    system: PACKAGE_REVIEW_SYSTEM,
    stablePrompt: renderBookBlock(units),
    prompt: renderSlidesBlock(slides, focusIds),
    output: {
      kind: 'json',
      validate: (text) => parseReviewerAnswer(text, { slideIds, quizIds, focusIds }),
      jsonSchema: PACKAGE_REVIEW_SCHEMA,
    },
  });
  return {
    answer: call.parsed as ReviewerAnswer,
    call: { provider: call.provider, modelString: call.modelString, usage: call.usage },
  };
}

/** The answer as stored findings, each anchored to its slide's title and order. */
export function toStoredFindings(
  answer: ReviewerAnswer,
  slides: readonly ReviewSlide[],
  idPrefix = 'f',
): StoredFinding[] {
  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  return answer.findings.map((finding, index) => {
    const slide = byId.get(finding.targetId);
    return {
      id: `${idPrefix}${index + 1}`,
      targetId: finding.targetId,
      targetTitle: slide?.title ?? '',
      targetOrder: slide ? slide.order : null,
      check: finding.check,
      severity: finding.severity,
      bookEvidence: finding.bookEvidence,
      whatIsWrong: finding.whatIsWrong,
      fixNote: finding.fixNote,
      status: 'open',
      teacherReason: null,
    };
  });
}

/** Status from the findings (plan §4.4, §4.10): nothing → passed; all fixed → fixed. */
export function reviewStatusOf(
  findings: readonly StoredFinding[],
): 'passed' | 'fixed' | 'needs_teacher' {
  if (findings.length === 0) return 'passed';
  return findings.every((finding) => finding.status === 'fixed') ? 'fixed' : 'needs_teacher';
}

/** The event payload (contract §3.2): ids, status, counts, check codes. No text. */
function completedPayload(review: PackageReview) {
  const open = review.findings.filter((finding) => finding.status === 'open');
  return {
    review: {
      id: review.id,
      versionId: review.versionId,
      stageId: review.stageId,
      attemptId: review.attemptId,
      status: review.status,
      provider: review.provider,
      model: review.model,
      counts: {
        findings: review.findings.length,
        open: open.length,
        fixed: review.findings.length - open.length,
      },
      openChecks: [...new Set(open.map((finding) => finding.check))].sort(),
      errorCode: review.errorCode,
      completedAt: review.completedAt,
    },
  };
}

async function finalize(
  pool: ConnectableQueryable,
  review: PackageReview,
  workerId: string,
  outcome: ReviewOutcome,
  now: number,
): Promise<PackageReview | null> {
  return nodePostgresTransaction(pool)(async (tx: Queryable) => {
    const finished = await finishReview(tx, review.id, workerId, outcome, now);
    if (!finished) return null;
    await enqueueWebhookEvent(
      tx,
      { tenantId: finished.tenantId, learningItem: finished.learningItem },
      'teaching_package.review_completed',
      () => completedPayload(finished),
    );
    return finished;
  });
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'TEACHING_MODEL_UNAVAILABLE' || code === 'SUBJECT_ROUTE_UNAVAILABLE') {
    return 'REVIEWER_UNAVAILABLE';
  }
  if (code === 'ACCOUNTING_UNAVAILABLE') return 'ACCOUNTING_UNAVAILABLE';
  return 'REVIEW_FAILED';
}

/**
 * Run (or resume) one review. Never throws: every failure ends the review
 * `unavailable` with its event. Returns the terminal row, or `null` when this
 * worker did not own the review.
 */
export async function runPackageReview(
  reviewId: string,
  deps: PackageReviewDeps = {},
): Promise<PackageReview | null> {
  const pool =
    deps.pool ?? (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
  const now = deps.now ?? Date.now;
  const workerId = deps.workerId ?? currentWorkerId();
  const claimed = await claimReview(pool as unknown as Queryable, reviewId, {
    workerId,
    now: now(),
    leaseMs: REVIEW_LEASE_MS,
  });
  if (!claimed) return null;

  const end = (outcome: ReviewOutcome) => finalize(pool, claimed, workerId, outcome, now());
  const unavailable = (errorCode: string) => end({ status: 'unavailable', errorCode });

  try {
    if (claimed.runAttempts > MAX_REVIEW_RUN_ATTEMPTS) {
      return await unavailable('REVIEW_ATTEMPTS_EXHAUSTED');
    }
    const version = await readVersionById(pool as unknown as Queryable, claimed.versionId);
    if (!version || version.tenantId !== claimed.tenantId)
      return await unavailable('VERSION_NOT_FOUND');
    if (version.currentStageId !== claimed.stageId) return await unavailable('VERSION_CHANGED');

    const book = await loadReviewBookUnits(pool as unknown as Queryable, {
      tenantId: claimed.tenantId,
      attemptId: claimed.attemptId,
    });
    if (book.units.length === 0) return await unavailable('NO_BOOK_SOURCE');
    const scenes = await (deps.loadScenes ?? loadLiveScenes)(pool, claimed.stageId);
    if (!scenes) return await unavailable('STAGE_NOT_LIVE');
    const slides = reviewSlidesOf(scenes);

    const callReviewer = (request: ReviewCallRequest) =>
      (deps.callReviewer ?? callPackageReviewer)({ ...request, pool });
    const heartbeat = () =>
      renewReviewLease(pool as unknown as Queryable, claimed.id, {
        workerId,
        now: now(),
        leaseMs: REVIEW_LEASE_MS,
      });
    const recordUsage = async (
      call: ReviewCallAnswer['call'],
      extra: Parameters<typeof saveReviewProgress>[3],
    ) => {
      await saveReviewProgress(
        pool as unknown as Queryable,
        claimed.id,
        workerId,
        {
          ...extra,
          provider: call.provider,
          model: call.modelString,
          usage: {
            inputTokens: call.usage?.classes.inputTokensTotal ?? null,
            outputTokens: call.usage?.classes.outputTokensTotal ?? null,
            costUsd: call.usage?.cost.costUsd ?? null,
          },
        },
        now(),
      );
    };

    let review = claimed;
    let findings: StoredFinding[];
    if (claimed.reviewedAt === null) {
      // The paid first review: the whole package in one call.
      const { answer, call } = await callReviewer({ review: claimed, units: book.units, slides });
      findings = toStoredFindings(answer, slides);
      await recordUsage(call, { summary: answer.summary, findings, reviewedAt: now() });
      review = {
        ...claimed,
        summary: answer.summary,
        findings,
        provider: call.provider,
        model: call.modelString,
      };
    } else {
      // A resume: the first answer is stored; never pay for it twice.
      findings = claimed.findings;
    }

    let fixes: StoredFix[] = claimed.fixes;
    if (deps.fixLoop && findings.length > 0) {
      const result = await deps.fixLoop({
        pool,
        review,
        units: book.units,
        slides,
        scenes,
        findings,
        heartbeat,
        callReviewer: async (request) => {
          const answered = await callReviewer(request);
          await recordUsage(answered.call, {});
          return answered;
        },
        recordProgress: async (nextFindings, nextFixes) => {
          await saveReviewProgress(
            pool as unknown as Queryable,
            claimed.id,
            workerId,
            { findings: nextFindings, fixes: nextFixes },
            now(),
          );
        },
        now,
      });
      findings = result.findings;
      fixes = result.fixes;
    } else {
      // No fix loop: every finding is the teacher's (Phase 2 behaviour).
      findings = findings.map((finding) =>
        finding.status === 'open' && finding.teacherReason === null
          ? { ...finding, teacherReason: teacherOnlyReason(finding, slides) ?? 'NOT_ATTEMPTED' }
          : finding,
      );
    }
    return await end({ status: reviewStatusOf(findings), findings, fixes });
  } catch (error) {
    log.warn(
      `package review ${claimed.id} ended unavailable`,
      JSON.stringify(describeErrorSafely(error)),
    );
    try {
      return await unavailable(errorCodeOf(error));
    } catch (finalizeError) {
      // The lease lapses and the next sweep resumes the review.
      log.error(
        `package review ${claimed.id} could not be finalized`,
        JSON.stringify(describeErrorSafely(finalizeError)),
      );
      return null;
    }
  }
}

/** Findings no regeneration can fix (plan §4.3): they go straight to the teacher. */
export function teacherOnlyReason(
  finding: StoredFinding,
  slides: readonly ReviewSlide[],
): StoredFinding['teacherReason'] {
  if (finding.check === 'S5') return 'S5_TEACHER_ONLY';
  const slide = slides.find((candidate) => candidate.id === finding.targetId);
  if (!slide) return 'S5_TEACHER_ONLY';
  if (slide.bankQuiz) return 'BANK_QUIZ_NOT_REGENERABLE';
  const isQuizCheck = (PACKAGE_QUIZ_CHECKS as readonly string[]).includes(finding.check);
  if (isQuizCheck && slide.sceneType !== 'quiz') return 'REGENERATION_REFUSED';
  return null;
}

const runningReviews = new Set<string>();

/**
 * Start (or resume) every claimable review in the background. Called by the
 * boot + interval webhook sweep; never awaits a review, never throws.
 */
export async function sweepPackageReviews(
  deps: PackageReviewDeps & { pool: ConnectableQueryable },
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  let ids: string[] = [];
  try {
    ids = await listClaimableReviewIds(deps.pool as unknown as Queryable, now());
  } catch (error) {
    log.error('package review sweep failed', JSON.stringify(describeErrorSafely(error)));
    return [];
  }
  const started: string[] = [];
  for (const id of ids) {
    if (runningReviews.has(id)) continue;
    runningReviews.add(id);
    started.push(id);
    void runPackageReview(id, { ...defaultReviewDeps(), ...deps })
      .catch((error) => {
        log.error(`package review ${id} crashed`, JSON.stringify(describeErrorSafely(error)));
      })
      .finally(() => {
        runningReviews.delete(id);
      });
  }
  return started;
}

/** The signed read model (contract §4.1): everything the teacher's report needs. */
export function packageReviewWire(review: PackageReview) {
  const open = review.findings.filter((finding) => finding.status === 'open').length;
  return {
    id: review.id,
    versionId: review.versionId,
    stageId: review.stageId,
    attemptId: review.attemptId,
    status: review.status,
    provider: review.provider,
    model: review.model,
    summary: review.summary,
    findings: review.findings,
    fixes: review.fixes.map((fix) => ({
      sceneId: fix.sceneId,
      findingIds: fix.findingIds,
      outcome: fix.outcome,
      code: fix.code,
    })),
    counts: { findings: review.findings.length, open, fixed: review.findings.length - open },
    errorCode: review.errorCode,
    createdAt: review.createdAt,
    completedAt: review.completedAt,
  };
}

/** Production wiring (Phase 3 adds the fix loop here). */
export function defaultReviewDeps(): PackageReviewDeps {
  return {};
}
