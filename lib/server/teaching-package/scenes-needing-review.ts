/**
 * The "N slides need review" count Kafuo shows on the package card (21 Nov 2026).
 *
 * The runner writes `inputSnapshot.scenesNeedingReview` once, at the end of generation.
 * Nothing that changes a slide afterwards (a single-slide regeneration, an audio repair,
 * a later `NARRATION_MISSING` mark) touches it, so a read of the stored value drifted
 * from the Submit/Approve gate, which counts the live Stage. A read that can load the
 * attempt's live Stage therefore reports the gate's own count
 * (`slidesNeedingRegeneration`); the stored value is the fallback only when the Stage
 * cannot be read. Only the response changes — nothing is written back.
 */
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { slidesNeedingRegeneration } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import type { GenerationAttempt, GenerationInputSnapshot } from '@/lib/types/teaching-package';

/** The marked-scene count the runner recorded on the attempt, 0 when absent. */
export function storedScenesNeedingReview(attempt: GenerationAttempt): number {
  const value = (attempt.inputSnapshot as { scenesNeedingReview?: unknown } | undefined)
    ?.scenesNeedingReview;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * The Stage whose slides the count describes: a succeeded attempt's retained Stage while
 * it is still its version's current Stage. Slide edits write in place, so `stageId`
 * stays the live one; a displaced or released Stage is not read.
 */
function liveStageIdOf(attempt: GenerationAttempt): string | null {
  if (attempt.status !== 'succeeded') return null;
  if (attempt.displacedAt !== null || attempt.stageReleasedAt !== null) return null;
  return attempt.stageId;
}

/**
 * Slides of the live Stage that still carry a generation issue — the predicate the
 * `SLIDES_NEED_REGENERATION` gate refuses on — or null when the Stage cannot be read.
 * Must run outside any open transaction: the document store takes its own connection.
 */
async function liveScenesNeedingReview(stageId: string): Promise<number | null> {
  try {
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const document = await store.loadDocument(stageId);
    return document ? slidesNeedingRegeneration(document.scenes).length : null;
  } catch (error) {
    console.warn(
      'scenesNeedingReview: the live Stage could not be read; reporting the stored count',
      JSON.stringify(describeErrorSafely(error)),
    );
    return null;
  }
}

/**
 * The attempt as reported to Kafuo: `inputSnapshot.scenesNeedingReview` is the live
 * Stage's count when the Stage can be read, otherwise the stored value unchanged.
 */
export async function withLiveScenesNeedingReview(
  attempt: GenerationAttempt,
): Promise<GenerationAttempt> {
  const stageId = liveStageIdOf(attempt);
  if (!stageId) return attempt;
  const live = await liveScenesNeedingReview(stageId);
  if (live === null) return attempt;
  // The runner writes this key untyped (`patchSnapshot`); the response carries it the same way.
  const inputSnapshot = {
    ...attempt.inputSnapshot,
    scenesNeedingReview: live,
  } as GenerationInputSnapshot;
  return { ...attempt, inputSnapshot };
}
