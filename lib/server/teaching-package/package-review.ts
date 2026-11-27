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

import type {
  AppDocument,
  AppDocumentOutline,
  AppStage,
} from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import {
  labelScriptChanged,
  latinLabelRuns,
} from '@/lib/server/teaching-package/label-script-check';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  readAttemptById,
  readContentUnitsForAttempt,
  readVersionById,
} from '@/lib/persistence/teaching-package';
import {
  guideAnswerContextOf,
  removedGuideItemKeys,
} from '@/lib/server/teaching-package/guide-answer-context';
import { guideLeakIssueItems } from '@/lib/server/teaching-package/guide-answer-guard';
import {
  isBookPartPlacementModel,
  isGuideAnswerModel,
  isLearnerFirstModel,
} from '@/lib/server/teaching-package/book-coverage';
import { sumAttemptSpend, sumReviewSpend } from '@/lib/persistence/teaching-model-attempts';
import {
  TeachingCallAbortedError,
  TeachingModelUnavailableError,
} from '@/lib/server/teaching-model/execute';
import { loadRateCard, type RateCard } from '@/lib/server/teaching-model/rate-card';
import {
  runReviewerCall,
  type ReviewerCallResult,
} from '@/lib/server/teaching-model/reviewer-call';
import {
  REVIEWER_FALLBACK_MODEL,
  REVIEWER_PRIMARY_MODEL,
} from '@/lib/server/teaching-model/reviewer-policy';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { scenePlayPositions } from '@/lib/server/teaching-package/scene-position';
import {
  judgedUnitIds,
  loadReviewBookUnits,
  loadReviewFigures,
  figureRoomFor,
  pickReviewFigures,
  REVIEW_FIRST_CALL_IMAGE_SHARE,
  REVIEW_IMAGE_ATTEMPTS_PER_CALL,
  REVIEW_IMAGE_BUDGET_USD,
  REVIEW_IMAGE_MAX_TOKENS_PER_RUN,
  reviewedSceneDigest,
  reviewSlidesOf,
  withGuideAnswers,
  type ReviewBookUnit,
  type ReviewFigure,
  type ReviewFigureEvidence,
  type ReviewFigureSet,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  createPackageReviewFixLoop,
  teacherOnlyReason,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  BOOK_FIGURES_HEADING,
  BOOK_FIGURES_INCOMPLETE_NOTE,
  bookFigureLabel,
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SCHEMA_V2,
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V2,
  PACKAGE_REVIEW_SYSTEM_V11,
  PACKAGE_REVIEW_SYSTEM_V12,
  parseReviewerAnswer,
  renderBookBlock,
  renderSlidesBlock,
  type ReviewerAnswer,
} from '@/lib/server/teaching-package/package-review-prompt';
import {
  claimReview,
  finishReview,
  listClaimableReviewIds,
  packageReviewWire,
  releaseReviewLease,
  renewReviewLease,
  reviewSourceAttemptId,
  saveReviewProgress,
  type PackageReview,
  type ReviewOutcome,
  type ReviewProgress,
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
  /** The run's abort signal: aborted when the sweep evicts a hung run (set by the job). */
  signal?: AbortSignal;
  /**
   * RV-1 (g5.v12 only): the book figures this call may see, picked by the job within
   * the owner's cap (`pickReviewFigures`). Absent on every other package.
   */
  figures?: readonly ReviewFigure[];
  /** RV-1: a figure this call wanted is not sent (the figures' heading says so). */
  figuresIncomplete?: boolean;
  /**
   * RV-1/RV-4 (set by the fix loop on a re-check): the figures the slide's findings were
   * read from (`namedFigures` of their quotes), wanted even when another unit owns them.
   */
  alsoFigures?: readonly string[];
}

export interface ReviewCallAnswer {
  answer: ReviewerAnswer;
  /**
   * `usage` is the served attempt's; `attemptIds` names every paid attempt of
   * the call (L-4: the row totals sum them from the ledger).
   */
  call: Pick<ReviewerCallResult, 'provider' | 'modelString' | 'usage'> & {
    attemptIds?: readonly string[];
  };
  /**
   * RV-1/RV-4 (g5.v12 only): which wanted book figures this call showed, held back (the
   * run's cap, a call limit, a resumed run, a provider refusal of the figures) or could
   * not read. A re-check that did not see them is no proof: the fix loop keeps the
   * findings they concern open. Absent on every other package.
   */
  figureEvidence?: ReviewFigureEvidence;
}

/** The fix loop's view of one claimed review (Phase 3 fills it). */
export interface FixLoopContext {
  pool: ConnectableQueryable;
  review: PackageReview;
  units: readonly ReviewBookUnit[];
  slides: readonly ReviewSlide[];
  scenes: readonly AppScene[];
  findings: StoredFinding[];
  /**
   * g5.v10 (quality plan W2): the package is learner-first, so a fix that made its
   * slide worse is retried once and otherwise rolled back. Absent on every other package.
   */
  learnerFirst?: true;
  /** Keep the lease while fixing; false → stop (another worker took over). */
  heartbeat: () => Promise<boolean>;
  callReviewer: (request: ReviewCallRequest) => Promise<ReviewCallAnswer>;
  recordProgress: (findings: StoredFinding[], fixes: StoredFix[]) => Promise<void>;
  now: () => number;
  /** The run's abort signal (LOW-1): the paid regeneration and TTS stop with it. */
  signal?: AbortSignal;
  /**
   * RV-1/RV-4 (g5.v12 only): whether this run can still show a slide's re-check every
   * readable book figure it wants. False → the fix loop does not pay for that slide's
   * regeneration; it leaves the slide for the next fresh run (Regenerate flagged).
   * Absent on every other package.
   */
  figureRoom?: (request: Pick<ReviewCallRequest, 'slides' | 'focusIds' | 'alsoFigures'>) => boolean;
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
  /** RV-1 test seam: the g5.v12 book figures (`null`: all of the Stage's). */
  loadFigures?: (
    pool: ConnectableQueryable,
    stageId: string,
    unitIds: ReadonlySet<string> | null,
  ) => Promise<ReviewFigureSet>;
  /** The sweep's tracker: called after the claim and after every renewed lease. */
  onLeaseKept?: () => void;
  /** Aborted by the sweep when it evicts this run; every reviewer call stops with it. */
  signal?: AbortSignal;
}

function documentStore(pool: ConnectableQueryable) {
  return createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as unknown as TransactionSource,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

export async function loadLiveScenes(
  pool: ConnectableQueryable,
  stageId: string,
): Promise<AppScene[] | null> {
  const document = (await documentStore(pool).loadDocument(stageId)) as AppDocument | null;
  return document ? (document.scenes as AppScene[]) : null;
}

/**
 * RV-1: the Stage's materialized book figures linked to `unitIds` (`null`: every one),
 * g5.v12 reviews only, only from this Stage's media.
 */
export async function loadStageFigures(
  pool: ConnectableQueryable,
  stageId: string,
  unitIds: ReadonlySet<string> | null,
): Promise<ReviewFigureSet> {
  const document = (await documentStore(pool).loadDocument(stageId)) as AppDocument | null;
  const outline = document?.outline as AppDocumentOutline | null | undefined;
  return loadReviewFigures(outline?.sourceVisuals, unitIds, { stageId });
}

/**
 * RV-1: one figure token at the highest input or cache-write rate of either reviewer
 * model, every tier included (Opus 5.5's and GPT-6 Sol's long-context cache write are
 * both $5 per 1M today). `0` when neither model is priced: then no figure is sent.
 */
export function reviewerImageTokenPriceUsd(card: RateCard = loadRateCard()): number {
  let perMillion = 0;
  for (const model of [REVIEWER_PRIMARY_MODEL, REVIEWER_FALLBACK_MODEL]) {
    const entry = card.entries[model];
    if (!entry) continue;
    for (const rate of [entry, ...(entry.tiers ?? [])]) {
      perMillion = Math.max(perMillion, rate.inputPerM, rate.cacheWritePerM ?? 0);
    }
  }
  return perMillion / 1_000_000;
}

/**
 * RV-1: the figure tokens one review run may send in all: the owner's $0.30, at the
 * highest figure-token price, for two paid attempts per call, and never more than
 * `REVIEW_IMAGE_MAX_TOKENS_PER_RUN` (an underpriced override cannot widen it). 30,000
 * at today's rates.
 */
export function reviewImageTokenBudget(price: number = reviewerImageTokenPriceUsd()): number {
  if (!(price > 0)) return 0;
  // Rounded to 6 places first: 0.3 / 1e-5 is 29999.999… in floating point.
  const tokens = REVIEW_IMAGE_BUDGET_USD / (price * REVIEW_IMAGE_ATTEMPTS_PER_CALL);
  return Math.min(REVIEW_IMAGE_MAX_TOKENS_PER_RUN, Math.floor(Number(tokens.toFixed(6))));
}

/**
 * RV-1: every route refused the request itself (an image it would not take) or declined
 * it on safety grounds (a classifier on a figure, say) -- never a timeout or an outage.
 */
function refusedRequest(error: unknown): boolean {
  return (
    error instanceof TeachingModelUnavailableError &&
    error.outcomes.length > 0 &&
    error.outcomes.every(
      (outcome) => outcome.outcome === 'request_rejected' || outcome.outcome === 'safety_refused',
    )
  );
}

/** RV-1: the figures as the reviewer call sends them, each after its label. */
function figureImages(figures: readonly ReviewFigure[], incomplete: boolean) {
  return figures.map((figure, index) => ({
    label:
      index === 0
        ? [
            BOOK_FIGURES_HEADING,
            ...(incomplete ? [BOOK_FIGURES_INCOMPLETE_NOTE] : []),
            bookFigureLabel(figure),
          ].join('\n')
        : bookFigureLabel(figure),
    data: figure.data,
    mediaType: figure.mediaType,
  }));
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
  // The attempt that produced the content (a stage review's producing attempt).
  const sourceAttemptId = review.attemptId ? reviewSourceAttemptId(review.attemptId) : '';
  // g5.v10 (learner-first plan W5): its packages are reviewed with
  // package-review-v2 (the weak-student checks S6/S7); every other package keeps v1.
  const attempt = sourceAttemptId ? await readAttemptById(request.pool, sourceAttemptId) : null;
  const learnerFirst = isLearnerFirstModel(attempt?.teachingModel);
  // g5.v11 (teacher-guide plan §8.6): its solving slides carry their approved guide
  // answers, and the rubric compares with them instead of re-solving (flag only).
  // Review finding 10: the items resolved to OUR book items with the run's own facts
  // (from the retained units' full text), shown by the names the writers saw.
  const guideAnswers = isGuideAnswerModel(attempt?.teachingModel);
  const guideContext =
    guideAnswers && attempt && sourceAttemptId
      ? guideAnswerContextOf({
          teachingModel: attempt.teachingModel,
          snapshot: attempt.inputSnapshot,
          units: await readContentUnitsForAttempt(request.pool, sourceAttemptId, {
            tenantId: review.tenantId,
          }),
          // Only the resolved items are read here, never the unit texts.
          language: null,
        })
      : null;
  const reviewed = guideAnswers
    ? withGuideAnswers(
        slides,
        guideContext?.resolved ?? null,
        removedGuideItemKeys(guideContext?.settlements),
      )
    : slides;
  // RV-1 (27 Nov 2026), g5.v12 only: its rubric names the book figures, and the call
  // carries the figures the job picked for it. Every other package is unchanged.
  const bookFigures = isBookPartPlacementModel(attempt?.teachingModel);
  const figures = bookFigures ? (request.figures ?? []) : [];
  const call = await runReviewerCall({
    pool: request.pool,
    tenantId: review.tenantId,
    subjectCode: review.subjectCode ?? 'UNKNOWN',
    capability: 'package_review',
    stage: PACKAGE_REVIEW_STAGE,
    association: {
      kind: 'generation',
      generationAttemptId: sourceAttemptId,
      versionId: review.versionId,
      learningItemType: review.learningItem.type,
      learningItemId: review.learningItem.id,
      reviewId: review.id,
    },
    aggregate: { tenantId: review.tenantId, learningItem: review.learningItem },
    system: bookFigures
      ? PACKAGE_REVIEW_SYSTEM_V12
      : guideAnswers
        ? PACKAGE_REVIEW_SYSTEM_V11
        : learnerFirst
          ? PACKAGE_REVIEW_SYSTEM_V2
          : PACKAGE_REVIEW_SYSTEM,
    stablePrompt: renderBookBlock(units, { truncated: request.bookTruncated === true }),
    ...(figures.length > 0
      ? { images: figureImages(figures, request.figuresIncomplete === true) }
      : {}),
    prompt: renderSlidesBlock(reviewed, focusIds, learnerFirst ? { learnerFirst } : {}),
    output: {
      kind: 'json',
      validate: (text) =>
        parseReviewerAnswer(text, {
          slideIds,
          quizIds,
          ...(focusIds ? { focusIds } : {}),
          ...(learnerFirst ? { learnerFirst } : {}),
        }),
      jsonSchema: learnerFirst ? PACKAGE_REVIEW_SCHEMA_V2 : PACKAGE_REVIEW_SCHEMA,
    },
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return {
    answer: call.parsed as ReviewerAnswer,
    call: {
      provider: call.provider,
      modelString: call.modelString,
      usage: call.usage,
      attemptIds: call.attemptIds,
    },
  };
}

type RowUsage = NonNullable<ReviewProgress['usage']>;

function servedUsage(usage: ReviewCallAnswer['call']['usage']): RowUsage {
  return {
    inputTokens: usage?.classes.inputTokensTotal ?? null,
    outputTokens: usage?.classes.outputTokensTotal ?? null,
    costUsd: usage?.cost.costUsd ?? null,
  };
}

/**
 * L-4: what one reviewer call cost, every paid attempt included (a truncated
 * Opus answer before the Sol fallback, say), summed from the ledger. Falls back
 * to the served attempt's usage when the ledger has none of them; accounting
 * never fails a review.
 */
async function callSpend(
  pool: ConnectableQueryable,
  tenantId: string,
  attemptIds: readonly string[] | undefined,
  served: RowUsage | null,
): Promise<RowUsage | null> {
  if (attemptIds && attemptIds.length > 0) {
    try {
      const spend = await sumAttemptSpend(pool as unknown as Queryable, attemptIds, { tenantId });
      if (spend.rows > 0) {
        return {
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          costUsd: spend.costUsd,
        };
      }
    } catch (error) {
      log.warn('reviewer spend read failed', JSON.stringify(describeErrorSafely(error)));
    }
  }
  return served;
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

/** The scene issue a g5.v11 run leaves on a slide it kept while it states a checked answer. */
const GUIDE_LEAK_ISSUE_CODE = 'GUIDE_ANSWER_LEAK';

function carriesGuideLeak(scene: AppScene): boolean {
  return (scene.generationIssues ?? []).some((issue) => issue.code === GUIDE_LEAK_ISSUE_CODE);
}

/**
 * g5.v11 (re-review finding 5c): each slide the run kept while it may still state a
 * checked answer before the learner's try (its `GUIDE_ANSWER_LEAK` scene issue) as one
 * must-fix S7 finding («a check is attempted before its solution is shown»), so the fix
 * loop regenerates that slide once like any other finding. The note names the items,
 * never an answer (the issue carries none). Ids `g<n>`, after the reviewer's `f<n>`.
 */
export function guideLeakFindings(
  scenes: readonly AppScene[],
  slides: readonly ReviewSlide[],
): StoredFinding[] {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const findings: StoredFinding[] = [];
  for (const slide of slides) {
    const scene = byId.get(slide.id);
    if (slide.sceneType !== 'slide' || !scene || !carriesGuideLeak(scene)) continue;
    const items = [
      ...new Set((scene.generationIssues ?? []).flatMap((issue) => guideLeakIssueItems(issue))),
    ];
    const answerOf =
      items.length === 0
        ? 'لأي بند'
        : items.length === 1
          ? `للبند ${items[0]}`
          : `للبنود ${items.join('، ')}`;
    findings.push({
      id: `g${findings.length + 1}`,
      targetId: slide.id,
      targetTitle: slide.title,
      targetOrder: slide.order,
      check: 'S7',
      severity: 'high',
      bookEvidence: { quote: '', unitId: null },
      whatIsWrong: `قد تذكر هذه الشريحة الإجابة النهائية ${answerOf} قبل أن يحاول المتعلم.`,
      // Only the named items: a solution slide solving others keeps their working.
      fixNote: `لا تذكر الإجابة النهائية ${answerOf} على هذه الشريحة، لا في نصها ولا في شرحها، وأبقِ كل ما سواه كما هو.`,
      status: 'open',
      teacherReason: null,
    });
  }
  return findings;
}

/**
 * 21 Nov 2026 (clear slide findings): each scene the run kept with a generation issue —
 * a placeholder slide, `NARRATION_MISSING`, `NARRATION_AUDIO_FAILED` or any other kept
 * code — is one must-fix `G1` finding, so the fix loop regenerates that slide once and
 * the submit/approve gate refuses the package until it is clean. The note names the
 * slide by position and title (ids are not readable, owner 21 Nov 2026) and lists the
 * issue codes; no book text. Ids `i<n>`, after the reviewer's `f<n>` and the leaks' `g<n>`.
 */
export function generationIssueFindings(
  scenes: readonly AppScene[],
  slides: readonly ReviewSlide[],
): StoredFinding[] {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  // The same play position the submit/approve gate names (review 21 Nov 2026).
  const positions = scenePlayPositions(scenes);
  const findings: StoredFinding[] = [];
  for (const slide of slides) {
    const scene = byId.get(slide.id);
    if (!scene) continue;
    const issues = (scene.generationIssues ?? []).filter(
      (issue) => issue.code !== GUIDE_LEAK_ISSUE_CODE,
    );
    if (issues.length === 0) continue;
    const codes = issues.map((issue) => issue.code).join(', ');
    const position = positions.get(slide.id) ?? slide.order;
    findings.push({
      id: `i${findings.length + 1}`,
      targetId: slide.id,
      targetTitle: slide.title,
      targetOrder: slide.order,
      check: 'G1',
      severity: 'high',
      bookEvidence: { quote: '', unitId: null },
      whatIsWrong: `الشريحة ${position}: «${slide.title}» أُبقيت ومكتوب فيها مشكلة توليد (${codes})؛ يجب إعادة توليدها قبل الإرسال.`,
      fixNote: `أعد توليد هذه الشريحة كاملة؛ أبقت مشكلة التوليد: ${codes}.`,
      status: 'open',
      teacherReason: null,
    });
  }
  return findings;
}

/**
 * D2 (21 Nov 2026), g5.v10/v11 only: each slide whose cited book units print a Latin label
 * run (ABCD, WXYZ, △PMQ) while its canvas writes the labels as spaced Arabic letters
 * («ز ي س و») is one must-fix `G2` finding — LABEL_SCRIPT_CHANGED — so the fix loop
 * regenerates that slide once with the book's own labels. Never fires when the book itself
 * prints Arabic labels. Ids `l<n>`, after the reviewer's `f<n>`, the leaks' `g<n>` and the
 * generation issues' `i<n>`.
 *
 * The fix note names the cited units' own Latin runs (review 21 Nov 2026), so the one
 * regeneration writes the book's labels, never a fixed example. A book read from its PDF
 * text only (`sourceKind: 'pdf_text'`, one unit with id `book`) gives no slide its cited
 * units' text, so the check finds nothing there: it fails open, never a false finding
 * (the whole book's text would match any slide against every label in the lesson).
 */
export function labelScriptFindings(
  slides: readonly ReviewSlide[],
  units: readonly { id: string; text: string }[],
): StoredFinding[] {
  const textOf = new Map(units.map((unit) => [unit.id, unit.text ?? '']));
  // The same play position the gate and the other findings name (review 21 Nov 2026).
  const positions = scenePlayPositions(slides);
  const findings: StoredFinding[] = [];
  for (const slide of slides) {
    if (slide.sceneType !== 'slide') continue;
    const unitText = (slide.citedUnitIds ?? [])
      .map((id) => textOf.get(String(id)) ?? '')
      .join('\n');
    if (!labelScriptChanged(slide.visibleText, unitText)) continue;
    const position = positions.get(slide.id) ?? slide.order;
    const bookRuns = latinLabelRuns(unitText).slice(0, MAX_NAMED_LABEL_RUNS).join('، ');
    findings.push({
      id: `l${findings.length + 1}`,
      targetId: slide.id,
      targetTitle: slide.title,
      targetOrder: slide.order,
      check: 'G2',
      severity: 'high',
      bookEvidence: { quote: '', unitId: null },
      whatIsWrong: `الشريحة ${position}: «${slide.title}» كتبت رموز الكتاب اللاتينية بحروف عربية (LABEL_SCRIPT_CHANGED)؛ يجب إعادة توليدها برموز الكتاب نفسها.`,
      fixNote: `أعد كتابة رموز الأشكال بحروف الكتاب اللاتينية نفسها (${bookRuns}) على الشريحة وفي الشرح.`,
      status: 'open',
      teacherReason: null,
    });
  }
  return findings;
}

/** The most Latin label runs one fix note names (the cited units' own, in book order). */
const MAX_NAMED_LABEL_RUNS = 8;

/** Each finding on a slide carries that slide's digest as it is in `scenes` now. */
export function withSceneDigests(
  findings: readonly StoredFinding[],
  scenes: readonly AppScene[],
): StoredFinding[] {
  const digests = new Map(scenes.map((scene) => [scene.id, reviewedSceneDigest(scene)]));
  return findings.map((finding) => {
    const digest = finding.targetId ? digests.get(finding.targetId) : undefined;
    return digest ? { ...finding, sceneDigest: digest } : finding;
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
      // The producing attempt, never a stage review's row key (dead end (a)).
      attemptId: reviewSourceAttemptId(review.attemptId),
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
  // The attempt that produced the reviewed content: a stage review (dead end (a)) reads
  // its producing attempt's book, Teaching Model and ledger rows, like any review.
  const sourceAttemptId = reviewSourceAttemptId(claimed.attemptId);

  // HIGH-1: an evicted (aborted) run never finalizes — even if the revoke of
  // its lease failed — so the run that resumes the review owns its ending.
  const end = async (outcome: ReviewOutcome) => {
    if (deps.signal?.aborted) return null;
    const usage = await reviewSpend();
    if (deps.signal?.aborted) return null;
    return finalize(pool, claimed, workerId, usage ? { ...outcome, usage } : outcome, now());
  };
  /**
   * L-B: at the end, the row's totals are the ledger's for this review id —
   * every paid attempt of every run, an evicted run's included. No ledger row
   * (or a failed read) keeps the running totals; accounting never fails a review.
   * LOW-4: an attempt still `started` at this moment (an evicted run's call in
   * flight) has no token columns yet, so it is not in these totals; the
   * ledger stays the authority for the review's spend.
   */
  const reviewSpend = async (): Promise<ReviewOutcome['usage'] | null> => {
    try {
      const spend = await sumReviewSpend(pool as unknown as Queryable, {
        tenantId: claimed.tenantId,
        generationAttemptId: sourceAttemptId,
        reviewId: claimed.id,
      });
      if (spend.rows === 0) return null;
      return {
        inputTokens: spend.inputTokens,
        outputTokens: spend.outputTokens,
        costUsd: spend.costUsd,
      };
    } catch (error) {
      log.warn('reviewer spend read failed', JSON.stringify(describeErrorSafely(error)));
      return null;
    }
  };
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
      attemptId: sourceAttemptId,
    });
    if (book.units.length === 0) return await unavailable('NO_BOOK_SOURCE');
    const scenes = await (deps.loadScenes ?? loadLiveScenes)(pool, claimed.stageId);
    if (!scenes) return await unavailable('STAGE_NOT_LIVE');
    const slides = reviewSlidesOf(scenes);

    // RV-1 (owner §2, 27 Nov 2026), g5.v12 only: the book figures of the units the slides
    // cite, read once per run through the existing crop reader. They are SENT only in a
    // review's first run (`runAttempts === 1`; a flagged-slide run is a first run too), so
    // the cap holds across resumes of one review; a resumed run reviews from text, and a
    // slide whose re-check would hold its figures back is left for a fresh run (RV-4). A
    // failed read (the attempt, the Stage outline or a figure) only reviews that unit from
    // its text, as before, and is logged; it never ends the review `unavailable`. Every
    // other package reviews exactly as before.
    //
    // The attempt is read ONCE per run, here, for every model gate of the job (the
    // deterministic findings of the first answer, the figures, the fix loop's
    // learner-first flow). A failed read gates nothing in -- never a new failure point.
    const attempt = await readAttemptById(pool as unknown as Queryable, sourceAttemptId)
      .then(
        (row) => row,
        () => null,
      )
      .catch(() => null);
    const bookFigures = isBookPartPlacementModel(attempt?.teachingModel);
    // What a fresh first run may send (a hold within it is curable), and this run's share.
    const freshRunBudget = bookFigures ? reviewImageTokenBudget() : 0;
    const figureBudget = claimed.runAttempts === 1 ? freshRunBudget : 0;
    let figureSet: ReviewFigureSet | null = null;
    if (bookFigures) {
      try {
        // EVERY book figure of the Stage: a call wants its judged units' figures and the
        // ones its findings were read from (`alsoFigures`), whichever unit owns them. A
        // resumed run reads them too, so each is sorted right (unread, never sendable).
        figureSet = await (deps.loadFigures ?? loadStageFigures)(pool, claimed.stageId, null);
      } catch (error) {
        log.warn(
          `package review ${claimed.id}: the book figures could not be read; reviewed from text`,
          JSON.stringify(describeErrorSafely(error)),
        );
        // Nothing is listed: a finding that names a figure stays open (`loadFailed`).
        figureSet = { figures: [], unreadable: [], loadFailed: true };
      }
      if (figureSet.unreadable.length > 0) {
        log.warn(
          `package review ${claimed.id}: ${figureSet.unreadable.length} book figure(s) could not be read; their units are reviewed from text`,
        );
      }
    }
    let figureTokensLeft = figureBudget;
    /** One call's figures within what the run has left (the first call: its share). */
    const pickFigures = (request: ReviewCallRequest) => {
      const cap = request.focusIds
        ? figureTokensLeft
        : Math.min(figureTokensLeft, Math.floor(figureBudget * REVIEW_FIRST_CALL_IMAGE_SHARE));
      const picked = pickReviewFigures(
        figureSet!,
        judgedUnitIds(request.slides, request.focusIds),
        cap,
        request.alsoFigures ?? [],
        freshRunBudget,
      );
      figureTokensLeft -= picked.tokens;
      return picked;
    };
    /** RV-1/RV-4: can a slide's re-check still be shown its readable figures? */
    const figureRoom = (request: Pick<ReviewCallRequest, 'slides' | 'focusIds' | 'alsoFigures'>) =>
      figureRoomFor(
        figureSet!,
        judgedUnitIds(request.slides, request.focusIds),
        request.alsoFigures ?? [],
        figureTokensLeft,
        freshRunBudget,
      );
    /** How many wanted figures one call did not show (any reason). */
    const unseen = (evidence: ReviewFigureEvidence) =>
      evidence.held.length + evidence.unreadable.length + evidence.unsendable.length;
    // The figures could not be listed at all: the review did not see the whole book.
    const incomplete = (evidence: ReviewFigureEvidence) =>
      unseen(evidence) > 0 || figureSet?.loadFailed === true;

    /** L-4: a call that failed after paying (both routes down, say) still adds its spend. */
    const recordFailedSpend = async (error: unknown) => {
      const attemptIds = (error as { attemptIds?: unknown } | null)?.attemptIds;
      if (deps.signal?.aborted || !Array.isArray(attemptIds) || attemptIds.length === 0) return;
      try {
        const usage = await callSpend(pool, claimed.tenantId, attemptIds as string[], null);
        // L-A: the eviction may have landed during the spend read.
        if (usage && !deps.signal?.aborted) {
          await saveReviewProgress(
            pool as unknown as Queryable,
            claimed.id,
            workerId,
            { usage },
            now(),
          );
        }
      } catch (spendError) {
        log.warn('reviewer spend write failed', JSON.stringify(describeErrorSafely(spendError)));
      }
    };
    const callReviewer = async (request: ReviewCallRequest): Promise<ReviewCallAnswer> => {
      // LOW-3: an evicted run never starts another paid reviewer call.
      if (deps.signal?.aborted) throw new TeachingCallAbortedError([]);
      // RV-1: counted against the run's cap before the call (a failed call may have paid).
      const picked = figureSet ? pickFigures(request) : null;
      const send = (figures: readonly ReviewFigure[], evidence: ReviewFigureEvidence | null) =>
        (deps.callReviewer ?? callPackageReviewer)({
          ...request,
          bookTruncated: book.truncated,
          ...(figures.length > 0
            ? { figures, ...(evidence && incomplete(evidence) ? { figuresIncomplete: true } : {}) }
            : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
          pool,
        });
      try {
        const answered = await send(picked?.figures ?? [], picked?.evidence ?? null);
        return picked ? { ...answered, figureEvidence: picked.evidence } : answered;
      } catch (error) {
        await recordFailedSpend(error);
        // RV-1 (review 27 Nov 2026): when every route refused the request with its figures
        // (an image it will not take, or a safety decline over a figure), it is asked once
        // more WITHOUT them, so a figure never ends the review `unavailable`. A rejected
        // request is not billed; a safety decline may be, and its spend is recorded above.
        // The refused figures count as unread: that re-check proves nothing about them,
        // and a retry would meet the same refusal, so nothing retries it automatically.
        if (picked && picked.figures.length > 0 && refusedRequest(error) && !deps.signal?.aborted) {
          log.warn(
            `package review ${claimed.id}: the reviewer refused the request with its ${picked.figures.length} book figure(s); asked again without them`,
          );
          const evidence: ReviewFigureEvidence = {
            // A refused figure is not curable by a retry: it joins the unread ones.
            ...picked.evidence,
            sent: [],
            unreadable: [...picked.evidence.unreadable, ...picked.evidence.sent],
          };
          try {
            return { ...(await send([], evidence)), figureEvidence: evidence };
          } catch (retryError) {
            await recordFailedSpend(retryError);
            throw retryError;
          }
        }
        throw error;
      }
    };
    const heartbeat = async () => {
      // HIGH-1: an evicted run never renews, even when the revoke of its lease
      // failed, so it can never keep paying outside the in-flight cap.
      if (deps.signal?.aborted) return false;
      const kept = await renewReviewLease(pool as unknown as Queryable, claimed.id, {
        workerId,
        now: now(),
        leaseMs: REVIEW_LEASE_MS,
      });
      // M-A: an eviction that lands while the renewal is in flight still stops
      // the run before its next paid step.
      if (!kept || deps.signal?.aborted) return false;
      deps.onLeaseKept?.();
      return true;
    };
    /**
     * L-4: the row's tokens and cost add up every paid attempt of every call;
     * its provider and model are the first review's (set only by that save).
     * RV-5: the model that served each re-check is on that slide's fix entry
     * (`StoredFix.reviewModel`), so a resumed or flagged-slide run is named too.
     */
    const recordUsage = async (call: ReviewCallAnswer['call'], extra: ReviewProgress) => {
      if (deps.signal?.aborted) return; // an evicted run writes nothing
      const usage = await callSpend(
        pool,
        claimed.tenantId,
        call.attemptIds,
        servedUsage(call.usage),
      );
      if (deps.signal?.aborted) return; // L-A: the eviction landed during the spend read
      await saveReviewProgress(
        pool as unknown as Queryable,
        claimed.id,
        workerId,
        { ...extra, ...(usage ? { usage } : {}) },
        now(),
      );
    };

    let review = claimed;
    let findings: StoredFinding[];
    if (claimed.reviewedAt === null) {
      // The run's one attempt read (above) gates both deterministic findings (a failed
      // read adds nothing -- never a new failure point):
      // - g5.v11 (re-review finding 5c): a slide kept while it may still state a checked
      //   answer before the learner's try is a must-fix finding, stored with the first
      //   answer (a resume and a flagged-slide regeneration read it back);
      // - g5.v10/v11 (D2, 21 Nov 2026): the label-script check.
      // Any other Teaching Model gets neither finding and reviews exactly as before.
      let leakFindings: StoredFinding[] = [];
      if (scenes.some(carriesGuideLeak) && isGuideAnswerModel(attempt?.teachingModel)) {
        leakFindings = guideLeakFindings(scenes, slides);
      }
      // Every kept generation issue is a finding on any Teaching Model (a placeholder
      // or a silent slide is broken whatever generated it), stated before the paid call
      // so the reviewer's answer and the fix loop see it with the first answer.
      const issueFindings = generationIssueFindings(scenes, slides);
      // D2: never on earlier Teaching Models (owner D-9 B).
      const labelFindings = isLearnerFirstModel(attempt?.teachingModel)
        ? labelScriptFindings(slides, book.units)
        : [];
      // HIGH-1: the reads above may have stalled past the lease (evicted, or
      // claimed elsewhere): never start the paid call under a lost lease.
      if (!(await heartbeat())) {
        log.warn(`package review ${claimed.id}: the lease moved on before the first call`);
        return null;
      }
      // The paid first review: the whole package in one call.
      const { answer, call, figureEvidence } = await callReviewer({
        review: claimed,
        units: book.units,
        slides,
      });
      // An answer that arrives after the eviction is the resumed run's to get.
      if (deps.signal?.aborted) return null;
      findings = [
        ...toStoredFindings(answer, slides),
        ...leakFindings,
        ...issueFindings,
        ...labelFindings,
      ];
      // RV-1 (review 27 Nov 2026): a g5.v12 first review that could not see every book
      // figure of its units (the call's share, a resumed run, a figure it could not read)
      // did not read the whole book: the stored D-8 flag says so, so the Admin shows its
      // warning line, exactly as for a cut book text.
      const figuresCut = figureEvidence ? incomplete(figureEvidence) : false;
      if (figuresCut) {
        log.warn(
          `package review ${claimed.id}: the first review did not see ${unseen(
            figureEvidence!,
          )} book figure(s) of its units`,
        );
      }
      const bookTruncated = book.truncated || figuresCut;
      await recordUsage(call, {
        summary: answer.summary,
        findings,
        provider: call.provider,
        model: call.modelString,
        reviewedAt: now(),
        bookTruncated,
      });
      review = {
        ...claimed,
        summary: answer.summary,
        findings,
        provider: call.provider,
        model: call.modelString,
        bookTruncated,
      };
    } else {
      // A resume: the first answer is stored; never pay for it twice.
      findings = claimed.findings;
    }

    let fixes: StoredFix[] = claimed.fixes;
    if (deps.fixLoop && findings.length > 0) {
      // g5.v10 quality plan W2: the fix loop rolls back a fix that made a slide worse.
      // A failed read (the run's one read, above) keeps the v1 flow (review LOW: never a
      // new failure point).
      const learnerFirst = isLearnerFirstModel(attempt?.teachingModel);
      const result = await deps.fixLoop({
        pool,
        review,
        units: book.units,
        slides,
        scenes,
        findings,
        ...(learnerFirst ? { learnerFirst: true } : {}),
        ...(figureSet ? { figureRoom } : {}),
        heartbeat,
        callReviewer: async (request) => {
          const answered = await callReviewer(request);
          await recordUsage(answered.call, {});
          return answered;
        },
        recordProgress: async (nextFindings, nextFixes) => {
          if (deps.signal?.aborted) return; // an evicted run writes nothing
          await saveReviewProgress(
            pool as unknown as Queryable,
            claimed.id,
            workerId,
            { findings: nextFindings, fixes: nextFixes },
            now(),
          );
        },
        now,
        ...(deps.signal ? { signal: deps.signal } : {}),
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
    // 15 Nov 2026: each finding keeps its slide as the review last saw it (after
    // any fix), so a flagged-slide regeneration never overwrites a slide a person
    // edited since. A failed read keeps the in-memory scenes (best effort).
    const finalScenes =
      (await (deps.loadScenes ?? loadLiveScenes)(pool, claimed.stageId).catch(() => null)) ??
      scenes;
    findings = withSceneDigests(findings, finalScenes);
    return await end({ status: reviewStatusOf(findings), findings, fixes });
  } catch (error) {
    // L-1: an evicted run's aborted call is not the review's failure; the
    // eviction exists so the review is resumed.
    if (deps.signal?.aborted) return null;
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
  } finally {
    // L-D: a run that stopped because it was evicted gives up its own lease at
    // once (best effort, exact owner), so the review is claimable now rather
    // than when the lease lapses — even when the sweep's revoke failed.
    if (deps.signal?.aborted) {
      void releaseReviewLease(pool as unknown as Queryable, claimed.id, {
        workerId,
        now: now(),
      }).catch((error: unknown) => {
        log.error(
          `package review ${claimed.id}: its own lease could not be released`,
          error instanceof Error ? error.name : 'Error',
        );
      });
    }
  }
}

export { teacherOnlyReason };

/**
 * The reviews this process is running. `leaseKeptAt` moves on every claim and
 * renewed lease; `token` names the run, so a run that settles late never
 * removes the entry of the run that replaced it; `controller` aborts the run's
 * reviewer call when it is evicted.
 */
interface RunningReview {
  token: string;
  /** The run's lease owner (`<worker>#<token>`), revoked when it is evicted. */
  leaseOwner: string;
  leaseKeptAt: number;
  controller: AbortController;
}
const runningReviews = new Map<string, RunningReview>();

/**
 * Start (or resume) claimable reviews in the background, at most
 * `MAX_PACKAGE_REVIEWS_IN_FLIGHT` at once (D-6). Called by the boot + interval
 * webhook sweep; never awaits a review, never throws.
 *
 * A run that has not kept its lease for a whole lease period is hung (its row
 * is claimable again): it is evicted, its reviewer call aborted and its lease
 * revoked, so this process may resume the review (L-10, HIGH-1). Every run
 * claims under its own lease owner and checks its lease before each paid step,
 * so an evicted run that wakes up later neither pays nor writes.
 */
export async function sweepPackageReviews(
  deps: PackageReviewDeps & { pool: ConnectableQueryable },
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  for (const [id, entry] of runningReviews) {
    if (now() - entry.leaseKeptAt > REVIEW_LEASE_MS) {
      runningReviews.delete(id);
      entry.controller.abort();
      log.warn(`package review ${id} did not keep its lease; evicted from this process`);
      // HIGH-1: revoke its lease, so whatever the evicted run does later (a
      // heartbeat, a save, the finish) is refused, even if no run resumes it now.
      // L-2: never awaited — a run stuck in its finalize must not hold up the
      // sweep (and the webhook delivery after it); the exact-owner guard keeps
      // a late revoke harmless.
      void releaseReviewLease(deps.pool as unknown as Queryable, id, {
        workerId: entry.leaseOwner,
        now: now(),
      }).catch((error: unknown) => {
        log.error(
          `package review ${id}: the evicted lease could not be revoked`,
          error instanceof Error ? error.name : 'Error',
        );
      });
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
    const entry: RunningReview = {
      token,
      leaseOwner: `${deps.workerId ?? currentWorkerId()}#${token}`,
      leaseKeptAt: now(),
      controller: new AbortController(),
    };
    runningReviews.set(id, entry);
    started.push(id);
    void runPackageReview(id, {
      ...defaultReviewDeps(),
      ...deps,
      workerId: entry.leaseOwner,
      onLeaseKept: () => {
        entry.leaseKeptAt = now();
      },
      signal: entry.controller.signal,
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

/**
 * The signed read model (contract §4.1) lives with the store, so a read route
 * never loads the fix loop or the generation graph; re-exported here for the
 * existing imports.
 */
export { packageReviewWire };

/** Production wiring (Phase 3 adds the fix loop here). */
export function defaultReviewDeps(): PackageReviewDeps {
  // D-1: the reviewer fixes what it can by itself, once per slide.
  return { fixLoop: createPackageReviewFixLoop() };
}
