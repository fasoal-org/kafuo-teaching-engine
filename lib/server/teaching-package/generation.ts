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
  readAttempt,
  readAttemptByRequestId,
  readAttemptForUpdate,
  readVersion,
  readVersionForUpdate,
  updateAttempt,
} from '@/lib/persistence/teaching-package';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
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
  TeachingModelLineage,
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
  };
}

function validateStartRequest(request: StartGenerationAttemptRequest): void {
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
 * Validate, snapshot, and insert one attempt. Returns the attempt plus the
 * execution input — which lives only in the caller's memory from here on.
 */
export async function startGenerationAttempt(
  pool: ConnectableQueryable,
  request: StartGenerationAttemptRequest,
): Promise<{ attempt: GenerationAttempt; execution: GenerationExecutionInput }> {
  validateStartRequest(request);
  const snapshot = toGenerationInputSnapshot(request);
  const kind = request.versionId ? 'regeneration' : 'initial';

  if (kind === 'regeneration') {
    const version = await readVersion(pool, request.versionId!);
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
  const attempt = await withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      itemLockKey(request.learningItem),
    ]);

    // Idempotency: the same requestId returns the existing attempt.
    if (request.requestId) {
      const existing = await readAttemptByRequestId(tx, request.learningItem, request.requestId);
      if (existing) return existing;
    }

    // A crashed runner leaves `running` rows that would block the in-flight
    // index forever; reclaim them by age under the same lock. The execution
    // input was never persisted, so a crashed attempt cannot be resumed.
    await tx.query(
      `UPDATE teaching_package_generation_attempts
          SET status = 'failed', error = 'stale', completed_at = $1
        WHERE learning_item_type = $2 AND learning_item_id = $3
          AND status = 'running' AND created_at < $4`,
      [
        Date.now(),
        request.learningItem.type,
        request.learningItem.id,
        Date.now() - attemptStaleMs(),
      ],
    );

    if (kind === 'initial') {
      const active = await readActiveVersion(tx, request.learningItem);
      const next = await nextVersionNumber(tx, request.learningItem);
      if (active || next !== 1) {
        throw new TeachingPackageError(
          'INVALID_TRANSITION',
          'an initial attempt is valid only while the learning item has no version at all; use regeneration or create a successor',
        );
      }
    }

    try {
      return await insertAttempt(tx, {
        id: `tpa-${randomBytes(9).toString('base64url')}`,
        learningItem: request.learningItem,
        versionId: request.versionId ?? null,
        kind,
        status: 'queued',
        requestId: request.requestId ?? null,
        requestedByActorRef: request.actorRef.trim(),
        teachingModel: request.teachingModel,
        inputSnapshot: snapshot,
        now: Date.now(),
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        if (request.requestId) {
          const raced = await readAttemptByRequestId(tx, request.learningItem, request.requestId);
          if (raced) return raced;
        }
        throw new TeachingPackageError(
          'GENERATION_IN_PROGRESS',
          'a generation attempt is already queued or running for this learning item',
        );
      }
      throw error;
    }
  });

  return { attempt, execution: request.generation };
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

/** Fail an attempt (runner error path or completion refusal). */
export async function failGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  message: string,
): Promise<void> {
  await updateAttempt(pool, attemptId, {
    status: 'failed',
    error: message.slice(0, 2000),
    completedAt: Date.now(),
  });
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
  const attempt = await readAttempt(pool, attemptId);
  if (!attempt) {
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  }

  const withTransaction = nodePostgresTransaction(pool);
  try {
    return await withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        itemLockKey(attempt.learningItem),
      ]);
      const locked = await readAttemptForUpdate(tx, attemptId);
      // Reclaimed or already finished elsewhere: nothing to do.
      if (!locked || locked.status !== 'running') return locked;
      await lockLiveServiceStage(tx, stageId);
      const now = Date.now();

      if (locked.kind === 'initial') {
        const created = await createInitialVersion(tx, { attempt: locked, stageId, now });
        return markAttemptSucceeded(tx, locked.id, { stageId, versionId: created.id, now });
      }

      const version = await readVersionForUpdate(tx, locked.versionId!);
      if (!version) throw new TeachingPackageError('NOT_FOUND', 'the version disappeared');
      const previousStageId = version.currentStageId;
      if (previousStageId !== stageId) {
        await lockLiveServiceStage(tx, previousStageId);
      }
      await replaceStageAfterRegeneration(tx, { attempt: locked, version, stageId, now });
      return markAttemptSucceeded(tx, locked.id, { stageId, versionId: version.id, now });
    });
  } catch (error) {
    // The Stage was persisted but the version side cannot complete: tombstone
    // the orphan (unreferenced, so the guard allows it) and fail the attempt.
    await tombstoneStageMeta(pool as Queryable, stageId).catch(() => {});
    await failGenerationAttempt(
      pool,
      attemptId,
      error instanceof Error ? error.message : String(error),
    );
    return readAttempt(pool, attemptId);
  }
}
