/**
 * In-process Teaching Package generation runner (plan §8.3/§4.3.8), mirroring
 * `lib/server/classroom-job-runner.ts`: an in-memory `Map<string, Promise>`
 * deduplicates concurrent runs of the same attempt, and the execution input
 * lives only inside this closure — never in the database, logs, or progress.
 *
 * Kafuo attempts run a TWO-LAYER execution model:
 *
 *   Layer A (once per attempt): bounded acquisition of the lesson PDF →
 *   normalized source (text + source visuals) reused by every classroom run.
 *
 *   Layer B (bounded configurable runs): `generateClassroom` → exact-flow
 *   validation → valid: `completeGenerationAttempt` binds the Stage; invalid
 *   or thrown after reservation: compensate (tombstone + media removal) and
 *   retry; exhausted: the attempt fails. Regeneration failure leaves the
 *   previous usable Stage untouched.
 */
import { createLogger } from '@/lib/logger';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  generateClassroom,
  type ClassroomGenerationProgress,
} from '@/lib/server/classroom-generation';
import {
  claimQueuedAttemptForRun,
  incrementGenerationRuns,
  updateAttempt,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { removeStageMediaDir } from '@/lib/server/classroom-storage';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import { resolveModel } from '@/lib/server/resolve-model';
import {
  acquireContentResource,
  ContentResourceAcquisitionError,
  recordPdfContentSummary,
} from '@/lib/server/teaching-package/content-resource';
import {
  completeGenerationAttempt,
  failGenerationAttempt,
  recordResolvedLlmModel,
} from '@/lib/server/teaching-package/generation';
import type { KafuoGenerationContext } from '@/lib/server/teaching-package/kafuo-request';
import { validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import { materializeSourceImages } from '@/lib/server/teaching-package/source-images';
import { createTeachingPackagePersistenceSink } from '@/lib/server/teaching-package/stage-persistence-sink';
import type { GenerationExecutionInput } from '@/lib/types/teaching-package';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

const log = createLogger('TeachingPackageGeneration');
const runningAttempts = new Map<string, Promise<void>>();
const DEFAULT_MAX_GENERATION_RUNS = 3;

function maxGenerationRuns(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_MAX_GENERATION_RUNS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_GENERATION_RUNS;
}

async function runnerPool() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool;
}

/** Patch the one runner-writable snapshot key set: pdf/visual summary. */
async function patchSnapshot(
  pool: ConnectableQueryable,
  attemptId: string,
  patch: (snapshot: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const current = await pool.query<{ input_snapshot: Record<string, unknown> }>(
    `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
    [attemptId],
  );
  const snapshot = current.rows[0]?.input_snapshot;
  if (!snapshot) return;
  await pool.query(
    `UPDATE teaching_package_generation_attempts
        SET input_snapshot = $2::jsonb
      WHERE id = $1`,
    [attemptId, JSON.stringify(patch(snapshot))],
  );
}

/**
 * Compensate an invalid/thrown classroom run: the reserved Stage was never
 * bound to a version, so tombstone its meta (if the sink saved it) and remove
 * its media directory. The previous usable Stage of a regeneration is never
 * touched — only this run's own reserved id is.
 */
async function compensateRun(pool: ConnectableQueryable, stageId: string | null): Promise<void> {
  if (!stageId) return;
  await tombstoneStageMeta(pool, stageId).catch(() => {});
  await removeStageMediaDir(stageId);
}

/** The Kafuo two-layer execution path. */
async function runKafuoAttempt(
  attemptId: string,
  kafuo: KafuoGenerationContext,
  pool: ConnectableQueryable,
  onProgress: (progress: ClassroomGenerationProgress) => Promise<void>,
): Promise<void> {
  // Layer A — one bounded acquisition per attempt, shared by every run.
  const source = await acquireContentResource(kafuo.contentResource, {});
  await patchSnapshot(pool, attemptId, (snapshot) =>
    recordPdfContentSummary(snapshot, source),
  );
  // B1.2: retain the extracted lesson text for question generation after
  // approval. The presigned URL is transient and never stored; this row holds
  // only the extracted text and the measured resource identity.
  await upsertSourceContext(pool, {
    tenantId: kafuo.aggregate.tenantId,
    attemptId,
    contentResourceId: kafuo.contentResource.id,
    measuredSha256: source.measuredSha256,
    text: source.text,
  });

  const execution: GenerationExecutionInput = {
    requirement: kafuo.requirement,
    pdfContent: {
      text: source.text,
      images: source.images,
      pdfImages: source.visionImages,
    },
    ...kafuo.generation,
    teachingFlow: kafuo.teachingFlow,
  };

  let lastFailure: { code: string; message: string; retryable: boolean } | null = null;

  for (let run = 1; run <= maxGenerationRuns(); run += 1) {
    await incrementGenerationRuns(pool, attemptId);
    let reservedStageId: string | null = null;
    const sink = createTeachingPackagePersistenceSink(attemptId);
    const trackingSink = {
      reserve: sink.reserve.bind(sink),
      persist: sink.persist.bind(sink),
      release: sink.release.bind(sink),
    };
    const originalReserve = trackingSink.reserve;
    trackingSink.reserve = async (buildStage) => {
      const reserved = await originalReserve(buildStage);
      reservedStageId = reserved.id;
      return reserved;
    };

    try {
      await onProgress({
        step: 'generating_outlines',
        progress: 15,
        message: `Generation run ${run}/${maxGenerationRuns()}`,
        scenesGenerated: 0,
      });

      const result = await generateClassroom(execution, {
        baseUrl: '',
        persistence: trackingSink,
        sourceVisuals: {
          images: source.visionImages,
          materialize: async (stageId, selected) => {
            const selectedNormalized = source.normalizedImages.filter((image) =>
              selected.some((pdfImage) => pdfImage.id === image.id),
            );
            const { servingMapping, manifest } = await materializeSourceImages(
              selectedNormalized,
              stageId,
              kafuo.contentResource.id,
            );
            await patchSnapshot(pool, attemptId, (snapshot) => ({
              ...snapshot,
              sourceVisualSummary: {
                available: source.normalizedImages.length,
                selected: selected.length,
                materialized: manifest.length,
              },
            }));
            return { servingMapping, manifest, failedIds: [] };
          },
        },
      });

      const flowCheck = validateExactTeachingFlow(
        result.scenes,
        kafuo.teachingFlow,
        result.outlines,
      );
      if (!flowCheck.valid) {
        lastFailure = {
          code: 'TEACHING_MODEL_FLOW_MISMATCH',
          message: flowCheck.violation.message,
          retryable: true,
        };
        log.warn(
          `Teaching package attempt ${attemptId} run ${run} failed exact-flow validation: ${flowCheck.violation.reason}`,
        );
        await compensateRun(pool, result.id);
        continue;
      }

      // Valid Stage → the ONLY binding path.
      await completeGenerationAttempt(pool, attemptId, result.id);
      return;
    } catch (error) {
      const isAcquisition = error instanceof ContentResourceAcquisitionError;
      if (isAcquisition) {
        // Layer A already retried within its policy; surface the terminal
        // code and stop the attempt.
        await failGenerationAttempt(
          pool,
          attemptId,
          error.message,
          { code: error.code, retryable: error.retryable },
        );
        return;
      }
      const code =
        typeof (error as { code?: string }).code === 'string'
          ? (error as { code: string }).code
          : 'CLASSROOM_GENERATION_FAILED';
      const retryable = code === 'CLASSROOM_GENERATION_FAILED';
      lastFailure = {
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable,
      };
      log.warn(
        `Teaching package attempt ${attemptId} run ${run} threw (${code}); compensating`,
      );
      await compensateRun(pool, reservedStageId);
      if (!retryable) break;
    }
  }

  await failGenerationAttempt(pool, attemptId, lastFailure?.message ?? 'generation failed', {
    code: lastFailure?.code ?? 'TEACHING_MODEL_FLOW_MISMATCH',
    retryable: false,
  });
}

export function runGenerationAttempt(
  attemptId: string,
  execution: GenerationExecutionInput,
  kafuo?: KafuoGenerationContext,
): Promise<void> {
  const existing = runningAttempts.get(attemptId);
  if (existing) return existing;

  const attemptPromise = (async () => {
    try {
      const pool = await runnerPool();
      // Admission, not a status write. Only a `queued` attempt may start, and
      // only once: the predicate lives in the UPDATE, so a second invocation —
      // an idempotency replay that reached the runner, or a duplicate schedule
      // — claims nothing and returns without touching the row. The in-memory
      // `runningAttempts` map above only dedupes CONCURRENT calls in this
      // process; a sequential second call passes it freely, and this is what
      // stops such a call from resurrecting a terminal attempt (which then
      // died as ATTEMPT_RECLAIMED_STALE).
      const claimed = await claimQueuedAttemptForRun(pool, attemptId, Date.now());
      if (!claimed) {
        log.info(
          `Teaching package attempt ${attemptId} was not claimable (already running or terminal); skipping run`,
        );
        return;
      }

      // Record the resolved LLM model string (the one runner-writable snapshot
      // key) for debugging; resolution failure lets generation fail on its own.
      try {
        const { modelString } = await resolveModel({ stage: 'generate-classroom' });
        await recordResolvedLlmModel(pool, attemptId, modelString);
      } catch {
        // resolveModel throws only when no model is configured; the run below
        // surfaces the same failure through the generation pipeline itself.
      }

      const reportProgress = async (progress: unknown) => {
        await updateAttempt(pool, attemptId, { progress: progress as never }).catch(() => {});
      };

      if (kafuo) {
        await runKafuoAttempt(attemptId, kafuo, pool, reportProgress);
        return;
      }

      // Legacy path: `execution` is the caller's generation object passed
      // through unchanged, and `baseUrl = ''` keeps every stored media
      // reference origin-independent.
      const result = await generateClassroom(execution, {
        baseUrl: '',
        onProgress: (progress) => {
          void reportProgress(progress);
        },
        persistence: createTeachingPackagePersistenceSink(attemptId),
      });

      await completeGenerationAttempt(pool, attemptId, result.id);
    } catch (error) {
      const code =
        typeof (error as { code?: string }).code === 'string'
          ? (error as { code: string }).code
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Teaching package generation attempt ${attemptId} failed: ${code ?? 'unknown'}`, describeErrorSafely(error));
      try {
        const pool = await runnerPool();
        await failGenerationAttempt(pool, attemptId, message, {
          ...(code !== undefined ? { code } : {}),
        });
      } catch (markFailedError) {
        log.error(
          `Failed to persist failed status for attempt ${attemptId}:`,
          markFailedError,
        );
      }
    } finally {
      runningAttempts.delete(attemptId);
    }
  })();

  runningAttempts.set(attemptId, attemptPromise);
  return attemptPromise;
}
