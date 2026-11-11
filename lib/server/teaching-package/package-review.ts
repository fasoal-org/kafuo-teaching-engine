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
import { randomBytes } from 'node:crypto';

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
  createPackageReviewFixLoop,
  teacherOnlyReason,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import {
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

/**
 * D-7: one reviewer call is bounded at 15 min per attempt, so a primary plus
 * its fallback can take 30 min. The lease covers that whole call with margin
 * (renewed before every further step), so a second worker never claims a
 * review whose call is still running.
 */
export const REVIEW_LEASE_MS = 40 * 60 * 1000;
/** A review claimed this many times without finishing ends `unavailable`. */
export const MAX_REVIEW_RUN_ATTEMPTS = 3;
/** D-6: package reviews this process runs at once (provider limits, live generation). */
export const MAX_PACKAGE_REVIEWS_IN_FLIGHT = 2;
/** Ledger stage of the package reviewer's calls (the consumption report's `feature`). */
export const PACKAGE_REVIEW_STAGE = 'package-review';

export interface ReviewCallRequest {
  review: PackageReview;
  units: readonly ReviewBookUnit[];
  slides: readonly ReviewSlide[];
  /** Re-review: only these slides are judged; the rest are neighbours. */
  focusIds?: ReadonlySet<string>;
  /** D-8: the book was cut; the book block says so (set by the job on every call). */
  bookTruncated?: boolean;
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
  /** The sweep's tracker: called after the claim and after every renewed lease. */
  onLeaseKept?: () => void;
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
    stablePrompt: renderBookBlock(units, { truncated: request.bookTruncated === true }),
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
  deps.onLeaseKept?.();

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
      (deps.callReviewer ?? callPackageReviewer)({
        ...request,
        bookTruncated: book.truncated,
        pool,
      });
    const heartbeat = async () => {
      const kept = await renewReviewLease(pool as unknown as Queryable, claimed.id, {
        workerId,
        now: now(),
        leaseMs: REVIEW_LEASE_MS,
      });
      if (kept) deps.onLeaseKept?.();
      return kept;
    };
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
      await recordUsage(call, {
        summary: answer.summary,
        findings,
        reviewedAt: now(),
        bookTruncated: book.truncated,
      });
      review = {
        ...claimed,
        summary: answer.summary,
        findings,
        provider: call.provider,
        model: call.modelString,
        bookTruncated: book.truncated,
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

export { teacherOnlyReason };

/**
 * The reviews this process is running. `leaseKeptAt` moves on every claim and
 * renewed lease; `token` names the run, so a run that settles late never
 * removes the entry of the run that replaced it.
 */
const runningReviews = new Map<string, { token: string; leaseKeptAt: number }>();

/**
 * Start (or resume) claimable reviews in the background, at most
 * `MAX_PACKAGE_REVIEWS_IN_FLIGHT` at once (D-6). Called by the boot + interval
 * webhook sweep; never awaits a review, never throws.
 *
 * A run that has not kept its lease for a whole lease period is hung (its row
 * is claimable again): it is evicted, so this process may resume the review
 * (L-10). Every run claims under its own lease owner, so an evicted run that
 * wakes up later writes nothing.
 */
export async function sweepPackageReviews(
  deps: PackageReviewDeps & { pool: ConnectableQueryable },
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  for (const [id, entry] of runningReviews) {
    if (now() - entry.leaseKeptAt > REVIEW_LEASE_MS) {
      runningReviews.delete(id);
      log.warn(`package review ${id} did not keep its lease; evicted from this process`);
    }
  }
  const free = MAX_PACKAGE_REVIEWS_IN_FLIGHT - runningReviews.size;
  if (free <= 0) return [];
  let ids: string[] = [];
  try {
    ids = await listClaimableReviewIds(deps.pool as unknown as Queryable, now(), free);
  } catch (error) {
    log.error('package review sweep failed', JSON.stringify(describeErrorSafely(error)));
    return [];
  }
  const started: string[] = [];
  for (const id of ids) {
    if (runningReviews.has(id)) continue;
    const token = randomBytes(4).toString('hex');
    const entry = { token, leaseKeptAt: now() };
    runningReviews.set(id, entry);
    started.push(id);
    void runPackageReview(id, {
      ...defaultReviewDeps(),
      ...deps,
      workerId: `${deps.workerId ?? currentWorkerId()}#${token}`,
      onLeaseKept: () => {
        entry.leaseKeptAt = now();
      },
    })
      .catch((error) => {
        log.error(`package review ${id} crashed`, JSON.stringify(describeErrorSafely(error)));
      })
      .finally(() => {
        if (runningReviews.get(id)?.token === token) runningReviews.delete(id);
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
    /** D-8: the reviewer did not read the whole book (the report shows one warning line). */
    bookTruncated: review.bookTruncated,
    errorCode: review.errorCode,
    createdAt: review.createdAt,
    completedAt: review.completedAt,
  };
}

/** Production wiring (Phase 3 adds the fix loop here). */
export function defaultReviewDeps(): PackageReviewDeps {
  // D-1: the reviewer fixes what it can by itself, once per slide.
  return { fixLoop: createPackageReviewFixLoop() };
}
