/**
 * In-process Teaching Package generation runner (plan §8.3), mirroring
 * `lib/server/classroom-job-runner.ts`: an in-memory `Map<string, Promise>`
 * deduplicates concurrent runs of the same attempt, and the execution input
 * lives only inside this closure — never in the database, logs, or progress.
 */
import { createLogger } from '@/lib/logger';
import { generateClassroom } from '@/lib/server/classroom-generation';
import { updateAttempt } from '@/lib/persistence/teaching-package';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resolveModel } from '@/lib/server/resolve-model';
import {
  completeGenerationAttempt,
  failGenerationAttempt,
  recordResolvedLlmModel,
} from '@/lib/server/teaching-package/generation';
import { createTeachingPackagePersistenceSink } from '@/lib/server/teaching-package/stage-persistence-sink';
import type { GenerationExecutionInput } from '@/lib/types/teaching-package';

const log = createLogger('TeachingPackageGeneration');
const runningAttempts = new Map<string, Promise<void>>();

async function runnerPool() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool;
}

export function runGenerationAttempt(
  attemptId: string,
  execution: GenerationExecutionInput,
): Promise<void> {
  const existing = runningAttempts.get(attemptId);
  if (existing) return existing;

  const attemptPromise = (async () => {
    try {
      const pool = await runnerPool();
      await updateAttempt(pool, attemptId, { status: 'running', startedAt: Date.now() });

      // Record the resolved LLM model string (the one runner-writable snapshot
      // key) for debugging; resolution failure lets generation fail on its own.
      try {
        const { modelString } = await resolveModel({ stage: 'generate-classroom' });
        await recordResolvedLlmModel(pool, attemptId, modelString);
      } catch {
        // resolveModel throws only when no model is configured; the run below
        // surfaces the same failure through the generation pipeline itself.
      }

      // `execution` is Kafuo's generation object passed through unchanged, and
      // `baseUrl = ''` keeps every stored media reference origin-independent.
      const result = await generateClassroom(execution, {
        baseUrl: '',
        onProgress: (progress) => {
          void updateAttempt(pool, attemptId, { progress }).catch(() => {});
        },
        persistence: createTeachingPackagePersistenceSink(attemptId),
      });

      await completeGenerationAttempt(pool, attemptId, result.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Teaching package generation attempt ${attemptId} failed:`, error);
      try {
        const pool = await runnerPool();
        await failGenerationAttempt(pool, attemptId, message);
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
