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
 *   Layer B (bounded configurable runs): `generateClassroom` (with, on
 *   normalized runs, a Stage-1 Content-Unit grounding gate that rejects an
 *   ungrounded outline response before any Stage or Scene exists) → exact-flow
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
  acquireNormalizedContentResource,
  recordNormalizedContentSummary,
} from '@/lib/server/teaching-package/normalized-content-resource';
import {
  completeGenerationAttempt,
  failGenerationAttempt,
  recordResolvedLlmModel,
} from '@/lib/server/teaching-package/generation';
import type { KafuoGenerationContext } from '@/lib/server/teaching-package/kafuo-request';
import { validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import { assertOutlineContentUnitGrounding } from '@/lib/server/teaching-package/outline-grounding';
import {
  requireCompleteFlowPolicies,
  resolveFlowSkillPolicies,
  validateOutlineSkillSelections,
} from '@/lib/server/teaching-package/skill-policy';
import { materializeSourceImages } from '@/lib/server/teaching-package/source-images';
import { createTeachingPackagePersistenceSink } from '@/lib/server/teaching-package/stage-persistence-sink';
import type { SceneOutline } from '@/lib/types/generation';
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
  // Presence is authoritative: normalized failures never enter the PDF fallback.
  const source = kafuo.normalizedContentResource
    ? await acquireNormalizedContentResource(
        kafuo.normalizedContentResource,
        kafuo.aggregate.learningItem,
      )
    : await acquireContentResource(kafuo.contentResource, {});
  await patchSnapshot(pool, attemptId, (snapshot) =>
    kafuo.normalizedContentResource
      ? recordNormalizedContentSummary(
          snapshot,
          source as import('@/lib/server/teaching-package/normalized-content-resource').AcquiredNormalizedSource,
        )
      : recordPdfContentSummary(snapshot, source),
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
    ...(kafuo.normalizedContentResource
      ? {
          sourceKind: 'kafuo_normalized' as const,
          normalizedPackageId: kafuo.normalizedContentResource.id,
          normalizedSchemaVersion: kafuo.normalizedContentResource.schemaVersion,
          contentRevisionId: kafuo.normalizedContentResource.contentRevisionId,
          parseRunId: kafuo.normalizedContentResource.parseRunId,
          structureProfile: kafuo.normalizedContentResource.structureProfile,
        }
      : { sourceKind: 'pdf_fallback' as const }),
  });

  // The W6-derived governance mode, consumed as a VALUE (§B.13): the
  // `teachingSkills` marker was parsed once at the single detection point and
  // already lives on this context; nothing below re-tests marker presence.
  const governedByTeachingSkills = kafuo.teachingSkillsContract !== null;

  const execution: GenerationExecutionInput = {
    requirement: kafuo.normalizedContentResource
      ? `${kafuo.requirement}\n\nFor every outline, return a non-empty machine-readable sourceContentUnitIds array copied exactly from the [[CONTENT_UNIT]] identifiers in the authoritative normalized source.`
      : kafuo.requirement,
    pdfContent: {
      text: source.text,
      images: source.images,
      pdfImages: source.visionImages,
    },
    ...kafuo.generation,
    teachingFlow: kafuo.teachingFlow,
    // The prompt contract itself, not just prose on the requirement: this is
    // what makes the outline templates render `sourceContentUnitIds` into the
    // scene schema, the field table, and the closing reminders.
    ...(kafuo.normalizedContentResource ? { normalizedGrounding: true } : {}),
    // Module 3/4 W1: the governed authority travels as ONE value built here,
    // from the marker alone — `input.governed !== undefined` is the pipeline's
    // single governed-mode predicate (plan §7.1.1). The outline contract
    // boolean and every downstream governance branch derive from it.
    ...(governedByTeachingSkills
      ? {
          governed: {
            contract: kafuo.teachingSkillsContract as string,
            teachingModel: kafuo.teachingModel,
            flow: kafuo.teachingFlow,
          },
        }
      : {}),
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
        // Stage-1 gate — the BR-TS-048 fail-closed point (Module 2 W8). The gate
        // fires after outlines and BEFORE `sink.reserve`, so a governed refusal
        // costs no Stage reservation, no Scene generation, and no media write.
        // For a governed request the W5 vocabulary is enforced here: policy
        // completeness (SKILL_POLICY_REQUIRED) and exact-version resolution
        // (SKILL_NOT_FOUND / SKILL_VERSION_UNRESOLVED). W10 adds the
        // deterministic SELECTION validation on the emitted outline carriers:
        // invented identities, out-of-policy selections, and unsatisfied
        // required scope/role refuse here — never merely discouraged by prompt
        // wording. An invalid policy never reaches this depth — the single
        // parse seam refused it before the attempt existed — and no
        // unrestricted-catalog fallback exists: the gate below is the only
        // route onward for a governed request, and these refusals are terminal
        // (non-retryable), never re-rolled open.
        ...(governedByTeachingSkills || kafuo.normalizedContentResource
          ? {
              validateOutlines: (outlines: SceneOutline[]) => {
                if (governedByTeachingSkills) {
                  requireCompleteFlowPolicies(kafuo.teachingFlow, {
                    stageKeys: kafuo.teachingFlow.map((entry) => entry.stage),
                  });
                  resolveFlowSkillPolicies(kafuo.teachingFlow);
                  validateOutlineSkillSelections(outlines, kafuo.teachingFlow);
                }
                if (kafuo.normalizedContentResource) {
                  assertOutlineContentUnitGrounding(
                    outlines,
                    (
                      source as import('@/lib/server/teaching-package/normalized-content-resource').AcquiredNormalizedSource
                    ).manifest,
                    attemptId,
                    run,
                  );
                }
              },
            }
          : {}),
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
        await failGenerationAttempt(pool, attemptId, error.message, {
          code: error.code,
          retryable: error.retryable,
        });
        return;
      }
      const code =
        typeof (error as { code?: string }).code === 'string'
          ? (error as { code: string }).code
          : 'CLASSROOM_GENERATION_FAILED';
      // Both of these are the *model* answering badly, and a re-roll is the remedy for
      // each. `OUTLINE_CONTENT_UNIT_GROUNDING_INVALID` gets the same budget as
      // `TEACHING_MODEL_FLOW_MISMATCH` -- the same class of defect. It is also far cheaper
      // to spend now: the Stage-1 gate rejects before any Scene is generated.
      //
      // This grants no extra attempts: the bound is still the enclosing
      // `for (run = 1; run <= maxGenerationRuns(); ...)` loop, and every run still
      // compensates before the next. Only the decision to use a run already available
      // changes.
      //
      // Module 3/4 W1: `GOVERNED_FLOW_CONTEXT_UNRESOLVED` is deliberately NOT in
      // this set — an unresolvable authoritative context is a bad request, not a
      // bad model answer, so it terminates the attempt after compensation.
      const retryable =
        code === 'CLASSROOM_GENERATION_FAILED' || code === 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID';
      lastFailure = {
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable,
      };
      log.warn(`Teaching package attempt ${attemptId} run ${run} threw (${code}); compensating`);
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
      log.error(
        `Teaching package generation attempt ${attemptId} failed: ${code ?? 'unknown'}`,
        describeErrorSafely(error),
      );
      try {
        const pool = await runnerPool();
        await failGenerationAttempt(pool, attemptId, message, {
          ...(code !== undefined ? { code } : {}),
        });
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for attempt ${attemptId}:`, markFailedError);
      }
    } finally {
      runningAttempts.delete(attemptId);
    }
  })();

  runningAttempts.set(attemptId, attemptPromise);
  return attemptPromise;
}
