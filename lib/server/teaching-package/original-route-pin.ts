/**
 * "Regenerate as the original" (teaching-generation-model-admin-config-plan-
 * 2026-11-18 D-18; source-fidelity s6-s7-readiness §1.4 G1(b)).
 *
 * A full regeneration normally runs on the route the request carries, which the
 * Backend reads from TODAY's superadmin settings. With `routePin: "original"`
 * it runs on the route its version's producing attempt ran on instead:
 *
 * - that attempt's frozen `generationRoute` and `planRoute` (D-10), read through
 *   cloned versions by `readRetainedVersionContext`, exactly as slide
 *   regeneration reads them (D-6);
 * - or, when that attempt froze no `generationRoute`, the code table, but only
 *   while today's table still names the same policy version and the same two
 *   models the attempt recorded.
 *
 * It fails closed with ORIGINAL_ROUTE_UNAVAILABLE (409) before any attempt
 * exists. D-7's replacement by today's table is never used here: a pin that
 * silently ran another route would be no pin at all. A pinned route whose models
 * have no server key now is refused by `assertConfiguredGenerationRouteAvailable`
 * (GENERATION_ROUTE_UNAVAILABLE), as for a sent route.
 *
 * The generate route and both correction-resume routes call this after parsing
 * and before admission; the runner then reads `kafuo.modelRoute` /
 * `kafuo.planRoute` as it always has, and freezes them on the new attempt.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readRetainedVersionContext } from '@/lib/persistence/teaching-package';
import {
  parseGenerationModelRoute,
  routeSettingKeySubjectCode,
  type GenerationRouteField,
} from '@/lib/server/teaching-model/generation-catalog';
import {
  isSubjectCode,
  POLICY_VERSION,
  readRoutingMode,
  SUBJECT_MODEL_POLICY,
} from '@/lib/server/teaching-model/subject-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  assertConfiguredGenerationRouteAvailable,
  type KafuoGenerationContext,
} from '@/lib/server/teaching-package/kafuo-request';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';

/** The attempt-snapshot record of a pinned regeneration (`input_snapshot.routePin`). */
export interface OriginalRoutePinRecord {
  mode: 'original';
  /** The producing attempt whose route was copied. */
  sourceAttemptId: string;
}

export interface OriginalRoutePinResolution {
  /** The context with the producing attempt's `modelRoute` / `planRoute` (or neither). */
  kafuo: KafuoGenerationContext;
  routePin: OriginalRoutePinRecord;
}

function unavailable(message: string, details: Record<string, unknown>): TeachingPackageError {
  return new TeachingPackageError('ORIGINAL_ROUTE_UNAVAILABLE', message, details);
}

/**
 * The 202 echo of an honoured pin (plan D-18): `{ applied: "original", sourceAttemptId }`,
 * read from the attempt's own snapshot, so an idempotent replay of a pinned attempt echoes
 * it too. Absent on every unpinned attempt. A Backend that sent a pin and gets no echo
 * knows this Teaching Engine ignored it (an older build) and records the attempt so.
 */
export function routePinEchoOf(
  attempt: { inputSnapshot?: { routePin?: OriginalRoutePinRecord } | null } | null | undefined,
): { applied: 'original'; sourceAttemptId: string } | null {
  const pin = attempt?.inputSnapshot?.routePin;
  if (!pin || pin.mode !== 'original' || typeof pin.sourceAttemptId !== 'string') return null;
  return { applied: 'original', sourceAttemptId: pin.sourceAttemptId };
}

/** A frozen route re-validated against today's catalogue and the lesson's subject. */
function pinnedRoute(
  raw: GenerationModelRoute,
  field: GenerationRouteField,
  subjectCode: string,
  details: Record<string, unknown>,
): GenerationModelRoute {
  let route: GenerationModelRoute;
  try {
    route = parseGenerationModelRoute(raw, field);
  } catch (error) {
    throw unavailable(
      `the original attempt's ${field} can no longer run: ${error instanceof Error ? error.message : String(error)}`,
      { ...details, field },
    );
  }
  if (routeSettingKeySubjectCode(field, route.settingKey) !== subjectCode) {
    throw unavailable(
      `the original attempt's ${field}.settingKey ${route.settingKey} is not this lesson's subject ${JSON.stringify(subjectCode)}`,
      { ...details, field },
    );
  }
  return route;
}

/** Whether the attempt row's raw snapshot holds each frozen route key (well-formed or not). */
async function storedRouteKeysOf(
  queryable: Queryable,
  attemptId: string,
  tenantId: string,
): Promise<{ generationRoute: boolean; planRoute: boolean }> {
  const result = await queryable.query<{ has_generation: boolean; has_plan: boolean }>(
    `SELECT input_snapshot ? 'generationRoute' AS has_generation,
            input_snapshot ? 'planRoute' AS has_plan
       FROM teaching_package_generation_attempts
      WHERE id = $1 AND tenant_id = $2`,
    [attemptId, tenantId],
  );
  const row = result.rows[0];
  return { generationRoute: row?.has_generation === true, planRoute: row?.has_plan === true };
}

/**
 * A table original's thinking levels, from its own ledger: every slide-content and
 * narration row must name today's table target for its role (model and thinking label).
 * Planning stages are left out (they may run on a separate planning route). An attempt
 * with no such row cannot be verified, so it is refused.
 */
async function assertTableThinkingUnchanged(
  queryable: Queryable,
  attemptId: string,
  tenantId: string,
  table: (typeof SUBJECT_MODEL_POLICY)[keyof typeof SUBJECT_MODEL_POLICY],
  details: Record<string, unknown>,
): Promise<void> {
  const result = await queryable.query<{
    role: string;
    model_string: string;
    thinking_label: string | null;
  }>(
    `SELECT DISTINCT role, model_string, thinking_label
       FROM teaching_model_attempts
      WHERE generation_attempt_id = $1 AND tenant_id = $2
        AND capability = 'package_generation'
        AND (stage LIKE 'scene-content%' OR stage = 'scene-actions')`,
    [attemptId, tenantId],
  );
  if (result.rows.length === 0) {
    throw unavailable(
      `the original attempt ${attemptId} has no slide or narration ledger row, so its code-table thinking levels cannot be verified`,
      details,
    );
  }
  for (const row of result.rows) {
    const target = row.role === 'fallback' ? table.fallback : table.primary;
    if (row.model_string !== target.model || row.thinking_label !== target.label) {
      throw unavailable(
        `the original attempt's ${row.role} ran ${row.model_string} (${row.thinking_label ?? 'no thinking label'}); today's table runs ${target.model} (${target.label})`,
        details,
      );
    }
  }
}

/**
 * `null` when the request carries no pin (the context is used as it is).
 * Otherwise the pinned context and the record the new attempt keeps.
 */
export async function resolveOriginalRoutePin(
  queryable: Queryable,
  kafuo: KafuoGenerationContext,
): Promise<OriginalRoutePinResolution | null> {
  if (kafuo.routePin !== 'original') return null;
  const versionId = kafuo.versionId;
  const details: Record<string, unknown> = { versionId };
  if (!versionId) {
    // The parser already refuses this; kept so the helper never pins an initial attempt.
    throw new TeachingPackageError(
      'GENERATION_ROUTE_INVALID',
      'routePin "original" needs versionId: only a regeneration has an original attempt',
    );
  }
  if (readRoutingMode() === 'off') {
    throw unavailable(
      'routePin "original" cannot run while TEACHING_SUBJECT_ROUTING=off: there is no subject route to pin',
      details,
    );
  }
  const subjectCode = kafuo.subjectCode;
  if (!isSubjectCode(subjectCode)) {
    throw unavailable(
      `routePin "original" needs a routed subject; got ${JSON.stringify(subjectCode)}`,
      details,
    );
  }
  const retained = await readRetainedVersionContext(queryable, versionId, {
    tenantId: kafuo.aggregate.tenantId,
  });
  if (!retained) {
    throw unavailable(
      `teaching package ${versionId} has no producing attempt whose route could be pinned`,
      details,
    );
  }
  const snapshot = retained.inputSnapshot;
  const sourceDetails = { ...details, sourceAttemptId: retained.attemptId };
  if (!snapshot.subjectCode || !snapshot.policyVersion) {
    throw unavailable(
      `the original attempt ${retained.attemptId} records no subject route (it ran before subject routing, or with routing off)`,
      sourceDetails,
    );
  }
  if (snapshot.subjectCode.toUpperCase() !== subjectCode) {
    throw unavailable(
      `the original attempt ran under subject ${JSON.stringify(snapshot.subjectCode)}, not ${JSON.stringify(subjectCode)}`,
      sourceDetails,
    );
  }

  // `readRetainedVersionContext` drops a malformed frozen route with only a warning (the
  // later steps then use the table). Under a pin that would silently unpin, so the raw row
  // is asked whether the attempt HAD each route: had one but it no longer parses → refuse.
  const stored = await storedRouteKeysOf(queryable, retained.attemptId, kafuo.aggregate.tenantId);
  for (const [field, present] of [
    ['generationRoute', Boolean(snapshot.generationRoute)],
    ['planRoute', Boolean(snapshot.planRoute)],
  ] as const) {
    if (stored[field] && !present) {
      throw unavailable(
        `the original attempt's frozen ${field} is malformed and cannot be pinned`,
        { ...sourceDetails, field },
      );
    }
  }

  let modelRoute: GenerationModelRoute | undefined;
  if (snapshot.generationRoute) {
    modelRoute = pinnedRoute(snapshot.generationRoute, 'modelRoute', subjectCode, sourceDetails);
  } else {
    // The code table: honoured only while today's table is the one the attempt ran on.
    // The policy version alone is not enough (a model swap may keep its label), so the
    // two recorded models must match, and so must the thinking levels the attempt's
    // slide and narration calls ran with (the snapshot keeps none for a table run).
    const table = SUBJECT_MODEL_POLICY[subjectCode];
    if (
      snapshot.policyVersion !== POLICY_VERSION ||
      snapshot.primaryModel !== table.primary.model ||
      snapshot.fallbackModel !== table.fallback.model
    ) {
      throw unavailable(
        `the original attempt ran on the code table ${snapshot.policyVersion} (${snapshot.primaryModel ?? '?'} → ${snapshot.fallbackModel ?? '?'}); today's table is ${POLICY_VERSION} (${table.primary.model} → ${table.fallback.model})`,
        sourceDetails,
      );
    }
    await assertTableThinkingUnchanged(
      queryable,
      retained.attemptId,
      kafuo.aggregate.tenantId,
      table,
      sourceDetails,
    );
  }
  const planRoute = snapshot.planRoute
    ? pinnedRoute(snapshot.planRoute, 'planRoute', subjectCode, sourceDetails)
    : undefined;

  const { modelRoute: _sentModel, planRoute: _sentPlan, ...rest } = kafuo;
  const pinned: KafuoGenerationContext = {
    ...rest,
    ...(modelRoute ? { modelRoute } : {}),
    ...(planRoute ? { planRoute } : {}),
  };
  // The same key check a sent route gets: both models must be keyed here now.
  assertConfiguredGenerationRouteAvailable(pinned);
  return {
    kafuo: pinned,
    routePin: { mode: 'original', sourceAttemptId: retained.attemptId },
  };
}
