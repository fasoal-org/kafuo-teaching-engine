/**
 * The model route of a LATER package step
 * (teaching-generation-model-admin-config-plan-2026-11-18 D-6, D-7): slide
 * regeneration (the AI review's fix loop included), slide insertion and
 * package questions run on the route frozen on the producing attempt's
 * `input_snapshot.generationRoute` (D-10), which `readRetainedVersionContext`
 * reads through cloned versions too.
 *
 * - A frozen route resolves as configured (`GENERATION_POLICY_VERSION`).
 * - A frozen route that can no longer resolve (its key was removed, or its
 *   model or thinking value left the catalogue) is replaced by today's table
 *   (Luna → Qwen, `r1-2026-09`), with a warning, and the replacement is returned
 *   as `routeReplaced: { from, reason }` for the step's route description.
 * - No frozen route (a package from before this feature, or a table route):
 *   today's table, unchanged.
 *
 * An unknown subject code is never "replaced": the table refuses it the same
 * way, so the refusal is re-thrown. The whole-package run does not use this:
 * there a configured route fails closed (D-11).
 */
import { createLogger } from '@/lib/logger';
import { storedGenerationRouteOf } from '@/lib/persistence/teaching-package';
import {
  resolveConfiguredGenerationPolicy,
  resolveSubjectModelPolicy,
  type ResolvedSubjectPolicy,
} from '@/lib/server/teaching-model/resolve-policy';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';

const log = createLogger('TeachingGenerationRoute');

/** D-7's record: the frozen route that could not run, and why. */
export interface GenerationRouteReplacement {
  from: GenerationModelRoute;
  reason: string;
}

export interface FrozenGenerationRouteResolution {
  policy: ResolvedSubjectPolicy;
  /** Present only when the frozen route was replaced by today's table (D-7). */
  routeReplaced?: GenerationRouteReplacement;
}

export async function resolveFrozenGenerationRoute(input: {
  subjectCode: string;
  /** The producing attempt's `input_snapshot.generationRoute`, as stored. */
  frozenRoute: unknown;
  /** Names the step in the warning (e.g. `slide regeneration tsr-1`). */
  step: string;
}): Promise<FrozenGenerationRouteResolution> {
  const frozen = storedGenerationRouteOf(input.frozenRoute);
  if (!frozen) return { policy: await resolveSubjectModelPolicy(input.subjectCode) };
  try {
    return { policy: await resolveConfiguredGenerationPolicy(input.subjectCode, frozen) };
  } catch (error) {
    const unavailable =
      error instanceof TeachingPackageError && error.code === 'SUBJECT_ROUTE_UNAVAILABLE';
    if (!unavailable || !isSubjectCode(input.subjectCode)) throw error;
    const policy = await resolveSubjectModelPolicy(input.subjectCode);
    log.warn(
      `${input.step}: the frozen generation route ${frozen.settingKey} (primary ${frozen.primary.model} ${frozen.primary.thinking}, fallback ${frozen.fallback.model} ${frozen.fallback.thinking}) cannot run; today's table ${policy.policyVersion} is used instead (D-7): ${error.message}`,
    );
    return { policy, routeReplaced: { from: frozen, reason: error.message } };
  }
}
