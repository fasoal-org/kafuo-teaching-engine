/**
 * Teaching Package generation attempts (plan §8.3).
 *
 * `startGenerationAttempt` validates the request, derives the lightweight
 * `GenerationInputSnapshot` (never the execution input), and inserts the
 * attempt row under the item's advisory lock. The transient execution input is
 * returned to the caller IN MEMORY ONLY — it is never serialized to the
 * database, logs, progress, or responses (BRD §17).
 *
 * `completeGenerationAttempt` is the completion transaction: after a valid
 * Stage has committed through the PG sink, it links version history (via
 * lifecycle's `createInitialVersion` / `replaceStageAfterRegeneration`) and
 * marks the attempt succeeded — or fails the attempt and tombstones the orphan
 * Stage when the version side cannot complete.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  insertAttempt,
  markAttemptSucceeded,
  nextVersionNumber,
  readActiveVersion,
  readAttemptById,
  readAttemptByRequestId,
  readAttemptForUpdate,
  readVersion,
  readVersionForUpdate,
  reclaimStaleAttempts,
  updateAttempt,
} from '@/lib/persistence/teaching-package';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import { removeStageMediaDir } from '@/lib/server/classroom-storage';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import { isPgUniqueViolation, TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  assertActorRef,
  createInitialVersion,
  itemLockKey,
  replaceStageAfterRegeneration,
} from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type {
  GenerationAttempt,
  GenerationExecutionInput,
  GenerationInputSnapshot,
  LearningItemRef,
  LearningObjectiveRef,
  TeachingFlowEntry,
  TeachingModelLineage,
  TeachingPackageAggregateKey,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

/** Key names that may never be persisted inside a generationContext. */
const SECRET_CONTEXT_KEY = /key|token|secret|password/i;
const STATEMENT_MAX_LENGTH = 2000;
const GENERATION_CONTEXT_MAX_BYTES = 64 * 1024;
const DEFAULT_ATTEMPT_STALE_MS = 30 * 60 * 1000;

function attemptStaleMs(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_ATTEMPT_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ATTEMPT_STALE_MS;
}

export interface StartGenerationAttemptRequest {
  /** Effective Kafuo tenant; `LEGACY_TENANT_ID` for the legacy body shape. */
  tenantId: string;
  learningItem: LearningItemRef;
  teachingModel: TeachingModelLineage;
  learningObjectives?: LearningObjectiveRef[];
  contentUnitRefs?: string[];
  sourceRefs?: string[];
  generationContext?: Record<string, unknown>;
  /** The execution input, handed through to generateClassroom verbatim. */
  generation: GenerationExecutionInput;
  /** Supplied ⇒ regeneration against that version. */
  versionId?: string;
  actorRef: string;
  /** Kafuo idempotency key. */
  requestId?: string;
  /** ---- Kafuo structured-request fields (plan §4.1.4) ---- */
  /** Semantic request digest; MANDATORY for Kafuo-shaped requests. */
  requestDigest?: string;
  /** Ordered Kafuo Teaching Model Flow (identity `(flowIndex, stage)`). */
  teachingFlow?: TeachingFlowEntry[];
  /**
   * Secret-free resource identity/integrity facts. Presence marks the request
   * as Kafuo-shaped; the transient signed URL never reaches this type.
   */
  contentResource?: GenerationInputSnapshot['contentResource'];
}

/** The request's canonical aggregate scope (plan §4.1.2). */
function aggregateOf(request: StartGenerationAttemptRequest): TeachingPackageAggregateKey {
  return { tenantId: request.tenantId, learningItem: request.learningItem };
}

export function toGenerationInputSnapshot(
  request: StartGenerationAttemptRequest,
): GenerationInputSnapshot {
  const { generation } = request;
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  return {
    learningItem: request.learningItem,
    teachingModel: request.teachingModel,
    learningObjectives: request.learningObjectives ?? [],
    contentUnitRefs: request.contentUnitRefs ?? [],
    sourceRefs: request.sourceRefs ?? [],
    generationContext: request.generationContext ?? {},
    generationOptions: {
      ...(generation.enableWebSearch !== undefined
        ? { enableWebSearch: generation.enableWebSearch }
        : {}),
      ...(generation.webSearchProviderId
        ? { webSearchProviderId: generation.webSearchProviderId }
        : {}),
      ...(generation.webSearchModelId ? { webSearchModelId: generation.webSearchModelId } : {}),
      ...(generation.baiduSubSources !== undefined
        ? { baiduSubSources: generation.baiduSubSources }
        : {}),
      ...(generation.enableImageGeneration !== undefined
        ? { enableImageGeneration: generation.enableImageGeneration }
        : {}),
      ...(generation.enableVideoGeneration !== undefined
        ? { enableVideoGeneration: generation.enableVideoGeneration }
        : {}),
      ...(generation.enableTTS !== undefined ? { enableTTS: generation.enableTTS } : {}),
      ...(generation.agentMode ? { agentMode: generation.agentMode } : {}),
    },
    requirementDigest: sha256(generation.requirement),
    requirementPreview: generation.requirement.slice(0, 200),
    pdfContentSummary: generation.pdfContent
      ? {
          present: true,
          textLength: generation.pdfContent.text.length,
          imageCount: generation.pdfContent.images.length,
          textDigest: sha256(generation.pdfContent.text),
        }
      : null,
    requestedAt: Date.now(),
    ...(request.tenantId ? { tenantId: request.tenantId } : {}),
    ...(request.teachingFlow ? { teachingFlow: request.teachingFlow } : {}),
    ...(request.contentResource ? { contentResource: request.contentResource } : {}),
    ...(request.requestDigest ? { requestDigest: request.requestDigest } : {}),
  };
}

function validateStartRequest(request: StartGenerationAttemptRequest): void {
  if (
    typeof request.tenantId !== 'string' ||
    request.tenantId.trim() === ''
  ) {
    throw new TeachingPackageError(
      'TENANT_REQUIRED',
      'tenantContext.tenantId must be a non-empty string',
    );
  }
  if (request.learningItem.type !== 'lesson' && request.learningItem.type !== 'section') {
    throw new TeachingPackageError(
      'UNSUPPORTED_LEARNING_ITEM_TYPE',
      'learningItem.type must be "lesson" or "section"',
    );
  }
  if (typeof request.learningItem.id !== 'string' || request.learningItem.id.trim() === '') {
    throw new TeachingPackageError('INVALID_REQUEST', 'learningItem.id must be a non-empty string');
  }
  if (!request.teachingModel?.key?.trim() || !request.teachingModel?.version?.trim()) {
    throw new TeachingPackageError(
      'MODEL_VERSION_REQUIRED',
      'teachingModel.key and teachingModel.version are required',
    );
  }
  assertActorRef(request.actorRef);
  if (
    typeof request.generation?.requirement !== 'string' ||
    request.generation.requirement.trim() === ''
  ) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'generation.requirement must be a non-empty string',
    );
  }
  // Kafuo-shaped requests enforce their own idempotency contract: the semantic
  // digest is computed by the parse layer and MUST accompany the attempt.
  if (request.contentResource !== undefined && !request.requestDigest) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'a Kafuo-shaped generation request must carry its semantic requestDigest',
    );
  }
  for (const [index, objective] of (request.learningObjectives ?? []).entries()) {
    if (
      !objective ||
      typeof objective.objectiveRef !== 'string' ||
      objective.objectiveRef.trim() === '' ||
      !objective.snapshot ||
      typeof objective.snapshot.statement !== 'string' ||
      objective.snapshot.statement.trim() === '' ||
      objective.snapshot.statement.length > STATEMENT_MAX_LENGTH
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `learningObjectives[${index}] requires an objectiveRef and a snapshot.statement (1..${STATEMENT_MAX_LENGTH} chars)`,
      );
    }
  }
  const context = request.generationContext;
  if (context !== undefined) {
    for (const key of Object.keys(context)) {
      if (SECRET_CONTEXT_KEY.test(key)) {
        throw new TeachingPackageError(
          'INVALID_REQUEST',
          `generationContext key ${JSON.stringify(key)} looks like a secret and is not accepted`,
        );
      }
    }
    if (Buffer.byteLength(JSON.stringify(context)) > GENERATION_CONTEXT_MAX_BYTES) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `generationContext must be at most ${GENERATION_CONTEXT_MAX_BYTES} bytes of JSON`,
      );
    }
  }
}

/**
 * Semantic idempotency on the requestId reuse path (plan §4.1.4): same scope +
 * same digest returns the existing attempt unchanged; a provided digest that
 * differs from the stored one — including a stored NULL (a legacy attempt) —
 * is an IDEMPOTENCY_CONFLICT. Legacy callers without a digest keep the
 * reuse-by-requestId behavior.
 */
/**
 * The outcome of attempt admission.
 *
 * `created` is the load-bearing bit: it says whether this transaction actually
 * INSERTED the attempt, or whether an existing one was handed back as an
 * idempotent replay. Callers schedule the runner on a newly created attempt and
 * on nothing else — a replay of a terminal attempt must stay terminal, and
 * re-running it is what turned a correct Kafuo idempotency replay into an
 * attempt reclaimed as stale.
 */
export interface GenerationAdmission {
  attempt: GenerationAttempt;
  execution: GenerationExecutionInput;
  /** True only when this call inserted the attempt row. */
  created: boolean;
}

function reuseOrConflict(
  existing: GenerationAttempt,
  request: StartGenerationAttemptRequest,
): GenerationAttempt {
  if (request.requestDigest !== undefined) {
    if (existing.requestDigest === null || existing.requestDigest !== request.requestDigest) {
      throw new TeachingPackageError(
        'IDEMPOTENCY_CONFLICT',
        'this requestId was already used with a different semantic payload',
      );
    }
  }
  return existing;
}

/**
 * Validate, snapshot, and insert one attempt. Returns the attempt plus the
 * execution input — which lives only in the caller's memory from here on.
 */
export async function startGenerationAttempt(
  pool: ConnectableQueryable,
  request: StartGenerationAttemptRequest,
): Promise<GenerationAdmission> {
  validateStartRequest(request);
  const snapshot = toGenerationInputSnapshot(request);
  const aggregate = aggregateOf(request);
  const kind = request.versionId ? 'regeneration' : 'initial';

  if (kind === 'regeneration') {
    const version = await readVersion(pool, request.versionId!, { tenantId: request.tenantId });
    if (!version) {
      throw new TeachingPackageError(
        'NOT_FOUND',
        `teaching package ${request.versionId} not found`,
      );
    }
    if (
      version.learningItem.type !== request.learningItem.type ||
      version.learningItem.id !== request.learningItem.id
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'the version belongs to a different learning item',
      );
    }
    if (version.status === 'in_review') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        'regeneration requires draft or rejected; start a review edit first while the version is in_review',
      );
    }
    if (version.status !== 'draft' && version.status !== 'rejected') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `regeneration is not permitted on a ${version.status} version`,
      );
    }
  }

  const withTransaction = nodePostgresTransaction(pool);
  const admitted = await withTransaction(async (tx): Promise<{
    attempt: GenerationAttempt;
    created: boolean;
  }> => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      itemLockKey(aggregate),
    ]);

    // Idempotency: the same requestId returns the existing attempt (digest
    // enforced for Kafuo requests). A replay, never an insert.
    if (request.requestId) {
      const existing = await readAttemptByRequestId(tx, aggregate, request.requestId);
      if (existing) return { attempt: reuseOrConflict(existing, request), created: false };
    }

    // A crashed runner leaves `queued`/`running` rows that would block the
    // in-flight index forever; reclaim them by age under the same lock. The
    // execution input was never persisted, so a crashed attempt cannot resume.
    await reclaimStaleAttempts(tx, aggregate, Date.now() - attemptStaleMs());

    if (kind === 'initial') {
      const active = await readActiveVersion(tx, aggregate);
      const next = await nextVersionNumber(tx, aggregate);
      if (active || next !== 1) {
        throw new TeachingPackageError(
          'INVALID_TRANSITION',
          'an initial attempt is valid only while the learning item has no version at all; use regeneration or create a successor',
        );
      }
    }

    try {
      const inserted = await insertAttempt(tx, {
        id: `tpa-${randomBytes(9).toString('base64url')}`,
        aggregate,
        versionId: request.versionId ?? null,
        kind,
        status: 'queued',
        requestId: request.requestId ?? null,
        requestDigest: request.requestDigest ?? null,
        requestedByActorRef: request.actorRef.trim(),
        teachingModel: request.teachingModel,
        inputSnapshot: snapshot,
        now: Date.now(),
      });
      return { attempt: inserted, created: true };
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        if (request.requestId) {
          // Race recovery is a replay too: another request with this id won the
          // insert, so this call created nothing and must not run the runner.
          const raced = await readAttemptByRequestId(tx, aggregate, request.requestId);
          if (raced) return { attempt: reuseOrConflict(raced, request), created: false };
        }
        // NOT a replay — the single-in-flight constraint refused a DIFFERENT
        // request, so this still throws rather than returning an attempt.
        throw new TeachingPackageError(
          'GENERATION_IN_PROGRESS',
          'a generation attempt is already queued or running for this learning item',
        );
      }
      throw error;
    }
  });

  return { attempt: admitted.attempt, execution: request.generation, created: admitted.created };
}

/** Emit `teaching_package.generation_succeeded` inside the binding transaction. */
async function emitGenerationSucceeded(
  tx: import('@openmaic/storage/document/pg').Queryable,
  attempt: GenerationAttempt,
  version: TeachingPackageVersion,
  now: number,
): Promise<void> {
  const aggregate: TeachingPackageAggregateKey = {
    tenantId: attempt.tenantId,
    learningItem: attempt.learningItem,
  };
  await enqueueWebhookEvent(
    tx,
    aggregate,
    'teaching_package.generation_succeeded',
    () => ({
      requestId: attempt.requestId ?? '',
      attempt: {
        id: attempt.id,
        kind: attempt.kind,
        status: 'succeeded',
        producedStageId: attempt.producedStageId ?? '',
        startedAt: attempt.startedAt ?? now,
        completedAt: now,
        generationRuns: attempt.generationRuns,
      },
      version: {
        id: version.id,
        version: version.version,
        status: version.status,
        currentStageId: version.currentStageId,
        currentAttemptId: version.currentAttemptId,
        teachingModel: version.teachingModel,
        updatedAt: version.updatedAt,
      },
    }),
  );
}

interface LiveStageRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
}

async function lockLiveServiceStage(tx: Queryable, stageId: string): Promise<void> {
  const result = await tx.query<LiveStageRow>(
    `SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 FOR UPDATE`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at !== null) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', `stage ${stageId} is not live`);
  }
  if (row.owner_id !== TEACHING_PACKAGE_STAGE_OWNER) {
    throw new TeachingPackageError(
      'STAGE_NOT_PACKAGE_ELIGIBLE',
      `stage ${stageId} is not owned by the teaching package service owner`,
    );
  }
}

/** Fail an attempt (runner error path or completion refusal) and emit the failure event. */
export async function failGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  message: string,
  failure?: { code?: string; retryable?: boolean },
): Promise<void> {
  const before = await readAttemptById(pool, attemptId);
  await updateAttempt(pool, attemptId, {
    status: 'failed',
    error: message.slice(0, 2000),
    ...(failure?.code !== undefined ? { errorCode: failure.code } : {}),
    ...(failure?.retryable !== undefined ? { errorRetryable: failure.retryable } : {}),
    completedAt: Date.now(),
  });
  if (before) {
    const aggregate: TeachingPackageAggregateKey = {
      tenantId: before.tenantId,
      learningItem: before.learningItem,
    };
    await enqueueWebhookEvent(pool as never, aggregate, 'teaching_package.generation_failed', () => ({
      requestId: before.requestId ?? '',
      attempt: {
        id: before.id,
        kind: before.kind,
        status: 'failed',
        versionId: before.versionId,
        producedStageId: before.producedStageId,
        startedAt: before.startedAt,
        completedAt: Date.now(),
        generationRuns: before.generationRuns,
      },
      error: {
        code: failure?.code ?? 'CLASSROOM_GENERATION_FAILED',
        message: message.slice(0, 500),
        retryable: failure?.retryable ?? false,
      },
    })).catch(() => {
      // Delivery rows may not exist yet (Phase 1 suite runs without them);
      // the sweep still reports the failed attempt through polling reads.
    });
  }
}

/** Patch the one runner-writable snapshot key: the resolved LLM model string. */
export async function recordResolvedLlmModel(
  pool: ConnectableQueryable,
  attemptId: string,
  modelString: string,
): Promise<void> {
  await pool.query(
    `UPDATE teaching_package_generation_attempts
        SET input_snapshot = jsonb_set(input_snapshot, '{resolvedLlmModel}', to_jsonb($2::text))
      WHERE id = $1`,
    [attemptId, modelString],
  );
}

/**
 * The completion transaction (§8.3 step 3), run after the Stage save committed
 * in its own owner-bound transaction. Links version history and marks the
 * attempt succeeded; on a version-side failure the Stage is tombstoned and the
 * attempt failed, so no partial package survives (BR-010 / AC-034).
 */
export async function completeGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  stageId: string,
): Promise<GenerationAttempt | null> {
  const attempt = await readAttemptById(pool, attemptId);
  if (!attempt) {
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  }
  const aggregate: TeachingPackageAggregateKey = {
    tenantId: attempt.tenantId,
    learningItem: attempt.learningItem,
  };

  const withTransaction = nodePostgresTransaction(pool);
  // Set inside the transaction, acted on only after it COMMITS: removing a
  // Stage's media directory is irreversible filesystem work, and doing it
  // inside a transaction that then rolls back would destroy the media of a
  // Stage that is still the version's live one.
  let retiredStageId: string | null = null;
  let committed: GenerationAttempt | null;
  try {
    committed = await withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        itemLockKey(aggregate),
      ]);
      const locked = await readAttemptForUpdate(tx, attemptId, { tenantId: attempt.tenantId });
      // Reclaimed or already finished elsewhere: nothing to do.
      if (!locked || locked.status !== 'running') return locked;
      await lockLiveServiceStage(tx, stageId);
      const now = Date.now();

      if (locked.kind === 'initial') {
        const created = await createInitialVersion(tx, { attempt: locked, stageId, now });
        const succeeded = await markAttemptSucceeded(tx, locked.id, {
          stageId,
          versionId: created.id,
          now,
        });
        await emitGenerationSucceeded(tx, succeeded!, created, now);
        return succeeded;
      }

      const version = await readVersionForUpdate(tx, locked.versionId!, {
        tenantId: locked.tenantId,
      });
      if (!version) throw new TeachingPackageError('NOT_FOUND', 'the version disappeared');
      const previousStageId = version.currentStageId;
      if (previousStageId !== stageId) {
        await lockLiveServiceStage(tx, previousStageId);
      }
      const replacement = await replaceStageAfterRegeneration(tx, {
        attempt: locked,
        version,
        stageId,
        now,
      });
      retiredStageId = replacement.retiredStageId;
      const succeeded = await markAttemptSucceeded(tx, locked.id, {
        stageId,
        versionId: version.id,
        now,
      });
      await emitGenerationSucceeded(tx, succeeded!, version, now);
      return succeeded;
    });
  } catch (error) {
    // The Stage was persisted but the version side cannot complete: tombstone
    // the orphan (unreferenced, so the guard allows it), remove its never-bound
    // media directory, and fail the attempt. This compensates the NEW Stage
    // only — the version is still on its existing Stage, which the rolled-back
    // transaction left live and current.
    await tombstoneStageMeta(pool as Queryable, stageId).catch(() => {});
    await removeStageMediaDir(stageId);
    await failGenerationAttempt(
      pool,
      attemptId,
      error instanceof Error ? error.message : String(error),
    );
    return readAttemptById(pool, attemptId);
  }
  // Committed: the version is on the new Stage and the old one is tombstoned,
  // so its media can go. Failure here is logged, never fatal — the lifecycle is
  // already correct and an orphaned directory is a benign leak, whereas failing
  // the attempt now would report a completed regeneration as failed.
  if (retiredStageId) {
    await removeStageMediaDir(retiredStageId).catch((error: unknown) => {
      console.warn(
        `Failed to remove media for replaced stage ${retiredStageId}`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }
  return committed;
}
