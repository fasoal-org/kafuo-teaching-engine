/**
 * The agent book review job and its sweep (Kafuo Agent API D2a; design note
 * `kafuo-agent-api-d2-design-2026-11-22.md` §1). On demand only: the Backend's
 * evaluation asks for it (202), this process's sweep runs it under a lease, and
 * the end is `teaching_package.agent_review_completed` (ids and status only).
 *
 * It shares the reviewer's route (`runReviewerCall`: Opus 5.5 high → GPT-6 Sol,
 * the switch and the probe) and lease pattern, and nothing else: its own table,
 * its own sweep with cap 1 (not `MAX_PACKAGE_REVIEWS_IN_FLIGHT`), no fix loop, no
 * `review_completed`, no gate effect. Metering: every call is a TE ledger row
 * (`capability: package_review`, `stage: agent-evaluation`), so the consumption
 * report shows it as production / `agent-evaluation`.
 *
 * Prompts, book text, images and answers are never logged.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { sumAttemptSpend } from '@/lib/persistence/teaching-model-attempts';
import { parseConstant } from '@/lib/server/teaching-package/agent-review-arithmetic';
import { runReviewerCall } from '@/lib/server/teaching-model/reviewer-call';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import { loadAgentScenes } from '@/lib/server/teaching-package/agent-read/load';
import type {
  AgentScene,
  AgentScenesProjection,
} from '@/lib/server/teaching-package/agent-read/scenes';
import {
  AGENT_BOOK_REVIEW_SCHEMA,
  AGENT_BOOK_REVIEW_SYSTEM,
  bookOrderAgentFindings,
  buildFinding,
  dedupeFindings,
  duplicateCandidates,
  groupScenes,
  missingFigureCandidates,
  pageImageLabel,
  parseAgentReviewAnswer,
  renderAgentBookBlock,
  renderAgentSlidesBlock,
  type AgentFinding,
  type BuildContext,
  type EvidenceImage,
  type RawAgentFinding,
} from '@/lib/server/teaching-package/agent-book-review-prompt';
import {
  claimAgentReview,
  finishAgentReview,
  listClaimableAgentReviewIds,
  releaseAgentReviewImages,
  renewAgentReviewLease,
  takeAgentReviewImages,
  type AgentReview,
  type AgentReviewGroup,
  type AgentReviewOutcome,
} from '@/lib/server/teaching-package/agent-book-review-store';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { readProducingAttemptId } from '@/lib/server/teaching-package/successor-model';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';

const log = createLogger('AgentBookReview');

/** Ledger stage, the consumption report's `feature` (design §3). */
export const AGENT_REVIEW_STAGE = 'agent-evaluation';
/** One agent review at a time per process (design §1). */
export const MAX_AGENT_REVIEWS_IN_FLIGHT = 1;
/** Covers every group's call (a primary plus its fallback each), renewed before every call. */
export const AGENT_REVIEW_LEASE_MS = 40 * 60 * 1000;
export const MAX_AGENT_REVIEW_RUN_ATTEMPTS = 3;
/** One retry of a group whose answer was rejected or whose call failed (design §1). */
const GROUP_CALL_TRIES = 2;

export interface AgentReviewDeps {
  pool: ConnectableQueryable;
  now?: () => number;
  workerId?: string;
  callReviewer?: typeof runReviewerCall;
  loadScenes?: (
    pool: ConnectableQueryable,
    version: TeachingPackageVersion,
  ) => Promise<AgentScenesProjection>;
  signal?: AbortSignal;
  /** The sweep's tracker: called after the claim and after every renewed lease. */
  onLeaseKept?: () => void;
  /** Test seam: the heartbeat period. */
  heartbeatMs?: number;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'TEACHING_MODEL_UNAVAILABLE' || code === 'SUBJECT_ROUTE_UNAVAILABLE') {
    return 'REVIEWER_UNAVAILABLE';
  }
  if (code === 'ACCOUNTING_UNAVAILABLE') return 'ACCOUNTING_UNAVAILABLE';
  return 'REVIEW_FAILED';
}

/** The terminal write and the signed event, in one transaction. */
async function finalize(
  pool: ConnectableQueryable,
  review: AgentReview,
  workerId: string | null,
  outcome: AgentReviewOutcome,
  now: number,
): Promise<AgentReview | null> {
  const finished = await nodePostgresTransaction(pool)(async (tx: Queryable) => {
    const row = await finishAgentReview(tx, review.id, outcome, { workerId, now });
    if (!row) return null;
    await enqueueWebhookEvent(
      tx,
      { tenantId: row.tenantId, learningItem: row.learningItem },
      'teaching_package.agent_review_completed',
      () => ({
        versionId: row.versionId,
        reviewId: row.id,
        status: row.status,
        evaluationId: row.evaluationId,
        // The total over every paid attempt, so the Backend can bill each one.
        spend: {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
          attempts: row.attemptIds.length,
        },
      }),
    );
    return row;
  });
  releaseAgentReviewImages(review.id);
  return finished;
}

const failed = (errorCode: string): AgentReviewOutcome => ({
  status: 'failed',
  findings: [],
  groups: [],
  provider: null,
  model: null,
  errorCode,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  attemptIds: [],
});

/** Renew the lease this often while a long reviewer call runs (a call may take 30 min). */
export const AGENT_REVIEW_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * The review's total spend over EVERY paid attempt (failed calls and fallbacks
 * included), summed from the ledger; the served answers' usage when the ledger
 * has none of them. Accounting never fails a review.
 */
export async function sumReviewSpend(
  queryable: Queryable,
  attemptIds: readonly string[],
  scope: { tenantId: string },
  served: { inputTokens: number; outputTokens: number; costUsd: number } | null,
): Promise<{ inputTokens: number | null; outputTokens: number | null; costUsd: number | null }> {
  if (attemptIds.length > 0) {
    try {
      const spend = await sumAttemptSpend(queryable, attemptIds, scope);
      if (spend.rows > 0) {
        return {
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          costUsd: spend.costUsd,
        };
      }
    } catch (error) {
      log.warn('agent review spend read failed', JSON.stringify(describeErrorSafely(error)));
    }
  }
  return served
    ? {
        inputTokens: served.inputTokens,
        outputTokens: served.outputTokens,
        costUsd: Math.round(served.costUsd * 1e8) / 1e8,
      }
    : { inputTokens: null, outputTokens: null, costUsd: null };
}

/** The profile constants the arithmetic can use; an unparsable one is skipped and logged by name. */
function usableConstants(
  reviewId: string,
  constants: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const usable: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(constants)) {
    if (parseConstant(value)) usable[name] = value;
    else log.warn(`agent review ${reviewId}: profile constant ${name} is not a number; skipped`);
  }
  return usable;
}

/**
 * Run one claimed review: code checks, then one reviewer call per group of ≤ 10
 * slides (retried once), the severity rules, the terminal write and the event.
 * Returns null when the review was not ours to run (or the lease was lost).
 */
export async function runAgentBookReview(
  id: string,
  deps: AgentReviewDeps,
): Promise<AgentReview | null> {
  const now = deps.now ?? Date.now;
  const { pool } = deps;
  const queryable = pool as unknown as Queryable;
  const workerId = deps.workerId ?? currentWorkerId();
  const review = await claimAgentReview(queryable, id, {
    workerId,
    now: now(),
    leaseMs: AGENT_REVIEW_LEASE_MS,
  });
  if (!review) return null;
  deps.onLeaseKept?.();
  // A heartbeat renews the lease while a long reviewer call runs, so the sweep
  // evicts only a run whose lease really expired. A lost lease aborts the run.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', forwardAbort);
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewAgentReviewLease(queryable, review.id, {
      workerId,
      now: now(),
      leaseMs: AGENT_REVIEW_LEASE_MS,
    })
      .then((kept) => {
        if (kept) deps.onLeaseKept?.();
        else {
          leaseLost = true;
          controller.abort();
        }
      })
      .catch(() => {
        // A failed heartbeat is retried on the next tick; the group renewal still guards.
      });
  }, deps.heartbeatMs ?? AGENT_REVIEW_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await runClaimedAgentReview(review, {
      ...deps,
      queryable,
      workerId,
      now,
      signal: controller.signal,
      isLeaseLost: () => leaseLost,
    });
  } finally {
    clearInterval(heartbeat);
    deps.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function runClaimedAgentReview(
  review: AgentReview,
  deps: AgentReviewDeps & {
    queryable: Queryable;
    workerId: string;
    now: () => number;
    signal: AbortSignal;
    isLeaseLost: () => boolean;
  },
): Promise<AgentReview | null> {
  const { pool, queryable, workerId, now } = deps;
  const id = review.id;
  if (review.runAttempts > MAX_AGENT_REVIEW_RUN_ATTEMPTS) {
    return finalize(pool, review, workerId, failed('RUN_ATTEMPTS_EXHAUSTED'), now());
  }
  const images: EvidenceImage[] = [];
  if (review.hasImages) {
    const held = takeAgentReviewImages(review.id, now());
    // Never stored: a restart (or the TTL) loses them; the Backend submits again.
    if (!held) return finalize(pool, review, workerId, failed('EVIDENCE_EXPIRED'), now());
    images.push(...held);
  }
  const version = await readVersionById(queryable, review.versionId);
  if (!version || version.tenantId !== review.tenantId) {
    return finalize(pool, review, workerId, failed('NOT_FOUND'), now());
  }
  const producing = await readProducingAttemptId(queryable, version.id);
  if (!producing) {
    return finalize(pool, review, workerId, failed('NO_PRODUCING_ATTEMPT'), now());
  }
  let projection: AgentScenesProjection;
  try {
    projection = await (deps.loadScenes ?? loadAgentScenes)(pool, version);
  } catch (error) {
    log.warn(`agent review ${id}: scenes unavailable`, JSON.stringify(describeErrorSafely(error)));
    return finalize(pool, review, workerId, failed('STAGE_NOT_LIVE'), now());
  }

  // One bad profile constant never stops the other computations (skipped, logged by name).
  const evidence = {
    ...review.evidence,
    constants: usableConstants(id, review.evidence.constants),
  };
  const ordered = projection.scenes;
  const scenes = new Map(ordered.map((scene) => [scene.scene_id, scene]));
  const blocksById = new Map(evidence.blocks.map((block) => [block.id, block]));
  const unitOfBlock = new Map<string, string>();
  const unitBlocks = new Map<string, string[]>();
  for (const unit of evidence.units) {
    unitBlocks.set(unit.contentUnitId, unit.blockIds);
    for (const block of unit.blockIds)
      if (!unitOfBlock.has(block)) unitOfBlock.set(block, unit.contentUnitId);
  }
  const duplicates = duplicateCandidates(ordered);
  const missingFigures = missingFigureCandidates(ordered);
  const scopeId = review.runId ?? review.versionId;
  const context: BuildContext = {
    scopeId,
    scenes,
    evidence,
    blocksById,
    unitOfBlock,
    duplicates,
    missingFigureSceneIds: new Set(missingFigures.map((entry) => entry.sceneId)),
  };
  const partnerText = new Map(ordered.map((scene) => [scene.scene_id, scene.text.slice(0, 600)]));
  const pagesByPdf = new Map(evidence.pages.map((page) => [page.pdfPage, page]));
  const stableImages = images.map((image) => ({
    label: pageImageLabel(pagesByPdf.get(image.pdfPage), image.pdfPage),
    data: image.data,
    mediaType: image.mediaType,
  }));
  const stablePrompt = renderAgentBookBlock(evidence);
  const call = deps.callReviewer ?? runReviewerCall;

  const findings: AgentFinding[] = bookOrderAgentFindings(scopeId, scenes, ordered, evidence.units);
  const groups: AgentReviewGroup[] = [];
  let provider: AgentReview['provider'] = null;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let metered = false;
  // Every paid attempt, failed calls included (their ids ride the error).
  const attemptIds: string[] = [];

  const sceneGroups = groupScenes(ordered);
  for (let index = 0; index < sceneGroups.length; index += 1) {
    const group = sceneGroups[index]!;
    const kept = await renewAgentReviewLease(queryable, review.id, {
      workerId,
      now: now(),
      leaseMs: AGENT_REVIEW_LEASE_MS,
    });
    // Lost lease (an evicted or reclaimed run): pay and write nothing more.
    if (!kept || deps.signal.aborted || deps.isLeaseLost()) return null;
    deps.onLeaseKept?.();
    const groupScenesById = new Map<string, AgentScene>(
      group.map((scene) => [scene.scene_id, scene]),
    );
    const scope = { scenes: groupScenesById, blockIds: new Set(blocksById.keys()) };
    let raws: RawAgentFinding[] | null = null;
    let errorCode: string | null = null;
    for (let tryNumber = 1; tryNumber <= GROUP_CALL_TRIES && raws === null; tryNumber += 1) {
      try {
        const answer = await call({
          pool,
          tenantId: review.tenantId,
          subjectCode: review.subjectCode ?? 'UNKNOWN',
          capability: 'package_review',
          stage: AGENT_REVIEW_STAGE,
          association: {
            kind: 'generation',
            generationAttemptId: producing.attemptId,
            versionId: review.versionId,
            learningItemType: review.learningItem.type,
            learningItemId: review.learningItem.id,
            reviewId: review.id,
          },
          aggregate: { tenantId: review.tenantId, learningItem: review.learningItem },
          system: AGENT_BOOK_REVIEW_SYSTEM,
          stablePrompt,
          ...(stableImages.length > 0 ? { stableImages } : {}),
          prompt: renderAgentSlidesBlock({
            group,
            unitBlocks,
            duplicates,
            missingFigures,
            partnerText,
          }),
          output: {
            kind: 'json',
            validate: (text) => parseAgentReviewAnswer(text, scope),
            jsonSchema: AGENT_BOOK_REVIEW_SCHEMA,
          },
          signal: deps.signal,
        });
        attemptIds.push(...answer.attemptIds);
        // `parsed` is what `validate` returned: the strictly parsed findings.
        if (!Array.isArray(answer.parsed)) throw new Error('the reviewer answer was not parsed');
        raws = answer.parsed as RawAgentFinding[];
        provider = answer.provider;
        model = answer.modelString;
        if (answer.usage) {
          metered = true;
          inputTokens += answer.usage.classes.inputTokensTotal ?? 0;
          outputTokens += answer.usage.classes.outputTokensTotal ?? 0;
          costUsd += answer.usage.cost.costUsd ?? 0;
        }
      } catch (error) {
        const failedAttempts = (error as { attemptIds?: unknown } | null)?.attemptIds;
        if (Array.isArray(failedAttempts)) {
          attemptIds.push(
            ...failedAttempts.filter((value): value is string => typeof value === 'string'),
          );
        }
        errorCode = errorCodeOf(error);
        log.warn(
          `agent review ${id}: group ${index} call ${tryNumber} failed`,
          JSON.stringify(describeErrorSafely(error)),
        );
      }
    }
    if (raws) {
      for (const raw of raws) {
        const finding = buildFinding(raw, context);
        if (finding) findings.push(finding);
      }
    }
    groups.push({
      index,
      sceneIds: group.map((scene) => scene.scene_id),
      status: raws ? 'succeeded' : 'failed',
      errorCode: raws ? null : errorCode,
    });
  }

  const failedGroups = groups.filter((group) => group.status === 'failed').length;
  const status: AgentReviewOutcome['status'] =
    groups.length > 0 && failedGroups === groups.length
      ? 'failed'
      : failedGroups > 0 || evidence.bookTruncated
        ? 'partial'
        : 'succeeded';
  const uniqueAttempts = [...new Set(attemptIds)];
  const spend = await sumReviewSpend(
    queryable,
    uniqueAttempts,
    { tenantId: review.tenantId },
    metered ? { inputTokens, outputTokens, costUsd } : null,
  );
  return finalize(
    pool,
    review,
    workerId,
    {
      status,
      findings: dedupeFindings(findings),
      groups,
      provider,
      model,
      errorCode: status === 'failed' ? (groups[0]?.errorCode ?? 'REVIEW_FAILED') : null,
      ...spend,
      attemptIds: uniqueAttempts,
    },
    now(),
  );
}

// ── The sweep (cap 1) ───────────────────────────────────────────────────────────────

interface RunningAgentReview {
  token: string;
  /** Moves on the claim, every group's renewal and every heartbeat. */
  leaseKeptAt: number;
  controller: AbortController;
}
const running = new Map<string, RunningAgentReview>();

/** Test seam. */
export function agentReviewsInFlight(): number {
  return running.size;
}

/**
 * Start claimable agent reviews in the background, at most
 * {@link MAX_AGENT_REVIEWS_IN_FLIGHT} at once. Never awaits a review, never throws.
 * A run whose lease EXPIRED (no claim, renewal or heartbeat for a whole lease
 * period) is evicted and its calls aborted; a long but live run renews its lease
 * every heartbeat and is never evicted. The lease owner guard keeps a late
 * wake-up from writing.
 */
export async function sweepAgentBookReviews(
  deps: Omit<AgentReviewDeps, 'signal' | 'onLeaseKept'>,
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  for (const [id, entry] of running) {
    if (now() - entry.leaseKeptAt > AGENT_REVIEW_LEASE_MS) {
      running.delete(id);
      entry.controller.abort();
      log.warn(`agent review ${id} did not keep its lease; evicted from this process`);
    }
  }
  const free = MAX_AGENT_REVIEWS_IN_FLIGHT - running.size;
  if (free <= 0) return [];
  let ids: string[] = [];
  try {
    ids = await listClaimableAgentReviewIds(deps.pool as unknown as Queryable, now(), free);
  } catch (error) {
    log.error('agent review sweep failed', JSON.stringify(describeErrorSafely(error)));
    return [];
  }
  const started: string[] = [];
  for (const id of ids) {
    if (running.has(id) || running.size >= MAX_AGENT_REVIEWS_IN_FLIGHT) continue;
    const token = randomBytes(4).toString('hex');
    const entry: RunningAgentReview = {
      token,
      leaseKeptAt: now(),
      controller: new AbortController(),
    };
    running.set(id, entry);
    started.push(id);
    void runAgentBookReview(id, {
      ...deps,
      workerId: `${deps.workerId ?? currentWorkerId()}#${token}`,
      signal: entry.controller.signal,
      onLeaseKept: () => {
        entry.leaseKeptAt = now();
      },
    })
      .catch((error) => {
        log.error(`agent review ${id} crashed`, JSON.stringify(describeErrorSafely(error)));
      })
      .finally(() => {
        if (running.get(id)?.token === token) running.delete(id);
      });
  }
  return started;
}
