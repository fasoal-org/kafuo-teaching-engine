/**
 * Resolve a subject's policy entry against the provider registry (plan §7.1).
 *
 * Both targets go through `resolveModel({ modelString })` with NO stage. That
 * is the whole point: `resolveModel` lets a configured `MODEL_ROUTES` stage
 * route win over the model string, and a teaching call must never be
 * re-routed by operator config (ROUTE-01). With no stage there is no route
 * lookup, so the policy's model string is the only input.
 *
 * Fail closed: an unknown code, or either target failing to resolve (missing
 * key, unregistered model, provider type mismatch), refuses the whole subject
 * with `SUBJECT_ROUTE_UNAVAILABLE`. A subject with only a working primary is
 * not "half routed" — the fallback is part of the approved route.
 */
import type { LanguageModel } from 'ai';

import type { ModelInfo, ThinkingConfig } from '@/lib/types/provider';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';
import { resolveModel } from '@/lib/server/resolve-model';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  GENERATION_POLICY_VERSION,
  parseGenerationModelRoute,
  thinkingConfigFor,
} from '@/lib/server/teaching-model/generation-catalog';
import {
  counterKindForProvider,
  isSubjectCode,
  POLICY_VERSION,
  SUBJECT_MODEL_POLICY,
  type CounterKind,
  type SubjectCode,
} from '@/lib/server/teaching-model/subject-policy';

export type TargetRole = 'primary' | 'fallback';

export interface ResolvedTarget {
  role: TargetRole;
  modelString: string;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  /** Registry entry; `null` only for unregistered ids, which resolution refuses. */
  modelInfo: ModelInfo;
  thinking: ThinkingConfig;
  thinkingLabel: string;
  counterKind: CounterKind;
}

export interface ResolvedSubjectPolicy {
  subjectCode: SubjectCode;
  policyVersion: string;
  primary: ResolvedTarget;
  fallback: ResolvedTarget;
}

/**
 * What `resolveTarget` needs: a table `PolicyTarget`, or a configured
 * catalogue target (teaching-generation-model-admin-config-plan-2026-11-18
 * D-11), whose model is any catalogue string rather than a `PolicyModelString`.
 */
interface ResolvableTarget {
  readonly model: string;
  readonly thinking: ThinkingConfig;
  readonly label: string;
}

async function resolveTarget(
  code: SubjectCode,
  role: TargetRole,
  target: ResolvableTarget,
): Promise<ResolvedTarget> {
  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    // No `stage`, no client key/baseUrl/providerType: the policy is server-owned.
    resolved = await resolveModel({ modelString: target.model });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject ${code}: ${role} model ${target.model} cannot be resolved (${detail})`,
      { subjectCode: code, role, model: target.model },
    );
  }
  if (!resolved.modelInfo) {
    // getModel tolerates an unregistered id (it just has no metadata). The
    // executor needs the output window and the vision flag, so a policy
    // target without registry metadata is a misconfiguration, not a model.
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject ${code}: ${role} model ${target.model} is not registered in the provider catalog`,
      { subjectCode: code, role, model: target.model },
    );
  }
  return {
    role,
    modelString: target.model,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    model: resolved.model,
    modelInfo: resolved.modelInfo,
    // The policy's thinking config wins over whatever resolveModel derived
    // (which, with no stage, is nothing anyway).
    thinking: target.thinking,
    thinkingLabel: target.label,
    counterKind: counterKindForProvider(resolved.providerId),
  };
}

/**
 * Resolve both targets of a subject. Throws `SUBJECT_ROUTE_UNAVAILABLE`
 * (HTTP 422) for an unknown code or an unresolvable target.
 */
export async function resolveSubjectModelPolicy(code: unknown): Promise<ResolvedSubjectPolicy> {
  if (!isSubjectCode(code)) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject code ${JSON.stringify(code)} is not in the routing policy ${POLICY_VERSION}`,
      { subjectCode: code },
    );
  }
  const entry = SUBJECT_MODEL_POLICY[code];
  const [primary, fallback] = await Promise.all([
    resolveTarget(code, 'primary', entry.primary),
    resolveTarget(code, 'fallback', entry.fallback),
  ]);
  return { subjectCode: code, policyVersion: POLICY_VERSION, primary, fallback };
}

/**
 * Resolve a superadmin-configured route for a subject
 * (teaching-generation-model-admin-config-plan-2026-11-18 D-11): the same
 * refusals as `resolveSubjectModelPolicy` — an unknown code, or either target
 * failing to resolve, throws `SUBJECT_ROUTE_UNAVAILABLE` (422). A route that is
 * no longer a valid catalogue route (a model or thinking value dropped from the
 * catalogue since it was frozen) is refused the same way, so a later step can
 * replace it with the table (D-7). Targets carry the catalogue thinking config
 * (`thinkingConfigFor`) and the chosen value as the ledger's `thinking_label`;
 * the policy version is `GENERATION_POLICY_VERSION`. No other model is tried.
 */
export async function resolveConfiguredGenerationPolicy(
  code: unknown,
  route: GenerationModelRoute,
): Promise<ResolvedSubjectPolicy> {
  if (!isSubjectCode(code)) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject code ${JSON.stringify(code)} is not in the routing policy ${POLICY_VERSION}`,
      { subjectCode: code },
    );
  }
  const settingKey = (route as Partial<GenerationModelRoute> | null | undefined)?.settingKey;
  let targets: Record<TargetRole, ResolvableTarget>;
  try {
    const valid = parseGenerationModelRoute(route);
    const targetOf = (role: TargetRole): ResolvableTarget => ({
      model: valid[role].model,
      thinking: thinkingConfigFor(valid[role].model, valid[role].thinking),
      label: valid[role].thinking,
    });
    targets = { primary: targetOf('primary'), fallback: targetOf('fallback') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject ${code}: the configured generation route ${JSON.stringify(settingKey)} cannot be resolved (${detail})`,
      { subjectCode: code, settingKey },
    );
  }
  const [primary, fallback] = await Promise.all([
    resolveTarget(code, 'primary', targets.primary),
    resolveTarget(code, 'fallback', targets.fallback),
  ]);
  return { subjectCode: code, policyVersion: GENERATION_POLICY_VERSION, primary, fallback };
}

/**
 * The package generation route of a subject (D-11): a configured route when
 * one is given, otherwise today's code table, unchanged. Both refuse with
 * `SUBJECT_ROUTE_UNAVAILABLE`; neither falls back to the other.
 */
export async function resolveGenerationRoute(input: {
  subjectCode: unknown;
  route?: GenerationModelRoute | null;
}): Promise<ResolvedSubjectPolicy> {
  return input.route
    ? resolveConfiguredGenerationPolicy(input.subjectCode, input.route)
    : resolveSubjectModelPolicy(input.subjectCode);
}
