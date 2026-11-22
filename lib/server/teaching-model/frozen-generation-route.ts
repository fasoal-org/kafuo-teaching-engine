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
  return resolveFrozenRoute(input.subjectCode, frozen, input.step, 'generation');
}

/**
 * The planning and review route of a LATER step on the same package
 * (package-planner-issue-resolve-plan-2026-11-22 §3c, D-5): e.g. a plan review
 * run on a paused attempt, where no re-sent request carries `planRoute`.
 *
 * - A frozen `planRoute` resolves as configured. One that can no longer
 *   resolve is replaced by today's table, recorded exactly as for the
 *   generation route (D-7).
 * - No frozen `planRoute`: planning follows the generation route (D-5's
 *   default), so the frozen `generationRoute` is resolved, which is today's
 *   table when that is absent too.
 */
export async function resolveFrozenPlanRoute(input: {
  subjectCode: string;
  /** The producing attempt's `input_snapshot.planRoute`, as stored. */
  frozenPlanRoute: unknown;
  /** The producing attempt's `input_snapshot.generationRoute`, as stored. */
  frozenGenerationRoute: unknown;
  step: string;
}): Promise<FrozenGenerationRouteResolution> {
  const frozen = storedGenerationRouteOf(input.frozenPlanRoute, 'planRoute');
  if (!frozen) {
    return resolveFrozenGenerationRoute({
      subjectCode: input.subjectCode,
      frozenRoute: input.frozenGenerationRoute,
      step: input.step,
    });
  }
  return resolveFrozenRoute(input.subjectCode, frozen, input.step, 'planning');
}

async function resolveFrozenRoute(
  subjectCode: string,
  frozen: GenerationModelRoute,
  step: string,
  label: 'generation' | 'planning',
): Promise<FrozenGenerationRouteResolution> {
  try {
    return {
      policy: await resolveConfiguredGenerationPolicy(
        subjectCode,
        frozen,
        label === 'planning' ? 'planRoute' : 'modelRoute',
      ),
    };
  } catch (error) {
    const unavailable =
      error instanceof TeachingPackageError && error.code === 'SUBJECT_ROUTE_UNAVAILABLE';
    if (!unavailable || !isSubjectCode(subjectCode)) throw error;
    const policy = await resolveSubjectModelPolicy(subjectCode);
    log.warn(
      `${step}: the frozen ${label} route ${frozen.settingKey} (primary ${frozen.primary.model} ${frozen.primary.thinking}, fallback ${frozen.fallback.model} ${frozen.fallback.thinking}) cannot run; today's table ${policy.policyVersion} is used instead (D-7): ${error.message}`,
    );
    return { policy, routeReplaced: { from: frozen, reason: error.message } };
  }
}
