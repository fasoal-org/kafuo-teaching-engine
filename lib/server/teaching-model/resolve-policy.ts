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
import { resolveModel } from '@/lib/server/resolve-model';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  counterKindForProvider,
  isSubjectCode,
  POLICY_VERSION,
  SUBJECT_MODEL_POLICY,
  type CounterKind,
  type PolicyTarget,
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

async function resolveTarget(
  code: SubjectCode,
  role: TargetRole,
  target: PolicyTarget,
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
