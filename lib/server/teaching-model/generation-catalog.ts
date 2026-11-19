/**
 * The teaching-package generation model catalogue
 * (teaching-generation-model-admin-config-plan-2026-11-18 D-12, D-13): the 11
 * models a Kafuo superadmin may pick for a subject, each model's thinking
 * values and prefilled default, whether each model is usable on THIS server,
 * and today's code table per subject expressed in catalogue values.
 *
 * Code-owned and pure: nothing here calls a provider or the network. A route a
 * request carries is checked twice:
 *  - its SHAPE and catalogue membership by the request parser
 *    (`parseGenerationModelRoute`, `GENERATION_ROUTE_INVALID`). No env is read
 *    there, so a request digest never depends on the server's keys;
 *  - its AVAILABILITY by the generate and resume routes
 *    (`generationModelAvailability`, `GENERATION_ROUTE_UNAVAILABLE`).
 *
 * Secret-free: availability is reported by the env var NAME, never a key,
 * value or base URL. The code table (`SUBJECT_MODEL_POLICY`, `POLICY_VERSION`)
 * is not touched (D-15): a chosen route is its own policy version,
 * `GENERATION_POLICY_VERSION`.
 */
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import { getModelInfo, getProvider } from '@/lib/ai/providers';
import { LLM_ENV_MAP, resolveApiKey } from '@/lib/server/provider-config';
import {
  SUBJECT_CODES,
  SUBJECT_MODEL_POLICY,
  type PolicyTarget,
  type SubjectCode,
} from '@/lib/server/teaching-model/subject-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type {
  ProviderId,
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
} from '@/lib/types/provider';
import type { GenerationModelRoute, GenerationRouteTarget } from '@/lib/types/teaching-package';

export type { GenerationModelRoute, GenerationRouteTarget } from '@/lib/types/teaching-package';

/** The policy version of a superadmin-configured route (D-11); the table keeps `r1-2026-09`. */
export const GENERATION_POLICY_VERSION = 'configured-2026-11';

/** `modelRoute.settingKey`: the Kafuo runtime setting the route came from (D-8, D-9). */
export const GENERATION_ROUTE_SETTING_KEY = /^teaching_generation\.route\.[A-Z][A-Z_]*$/;

export interface GenerationCatalogEntry {
  /** Canonical `provider:model` string. */
  readonly model: string;
  /** The thinking value the admin picker is prefilled with (D-4, D-13). */
  readonly defaultThinking: string;
}

function entry(model: string, defaultThinking: string): GenerationCatalogEntry {
  return Object.freeze({ model, defaultThinking });
}

/**
 * The 11 models of D-3, in picker order, with the D-13 defaults: Luna keeps
 * today's `low`; Terra the owner's `medium`; the others their API default;
 * Qwen3.7 Flash today's fallback `off`.
 */
export const GENERATION_MODEL_CATALOG: readonly GenerationCatalogEntry[] = Object.freeze([
  entry('openai:gpt-6-luna', 'low'),
  entry('openai:gpt-6.1-terra', 'medium'),
  entry('openai:gpt-6-sol', 'medium'),
  entry('anthropic:claude-opus-5-5', 'medium'),
  entry('anthropic:claude-sonnet-5-5', 'high'),
  entry('google:gemini-4-carbon', 'medium'),
  entry('google:gemini-4-hydrogen', 'high'),
  entry('qwen:qwen3.7-flash', 'off'),
  entry('qwen:qwen4-max', 'on'),
  entry('qwen:qwen3.8-max', 'on'),
  entry('qwen:qwen3.7-max', 'on'),
]);

function splitModelString(model: string): { providerId: string; modelId: string } {
  const colon = model.indexOf(':');
  return { providerId: model.slice(0, colon), modelId: model.slice(colon + 1) };
}

/** The catalogue entry for a model string, or undefined when it is not one of the 11. */
export function generationCatalogEntry(model: unknown): GenerationCatalogEntry | undefined {
  return typeof model === 'string'
    ? GENERATION_MODEL_CATALOG.find((candidate) => candidate.model === model)
    : undefined;
}

/**
 * A model's thinking values, from its registry capability (D-13): an effort
 * control offers its effort values in order, a level control its levels, and
 * Qwen's on/off switch (`toggle-budget`) offers `off` and `on`.
 */
export function generationThinkingOptions(model: string): readonly string[] {
  const { providerId, modelId } = splitModelString(model);
  const capability = getCatalogThinkingCapability(providerId, modelId);
  switch (capability?.control) {
    case 'effort':
      return [...(capability.effortValues ?? [])];
    case 'level':
      return [...(capability.levelValues ?? [])];
    case 'toggle':
    case 'toggle-budget':
      return ['off', 'on'];
    default:
      return [];
  }
}

/**
 * The unified thinking config the executor sends for a catalogue value (D-13):
 * effort → `{mode:'enabled', effort}` (`none` → `{mode:'disabled'}`); level →
 * `{mode:'enabled', level}`; Qwen `on` → `{mode:'enabled'}` (no budget sent),
 * `off` → `{mode:'disabled'}`. The ledger's `thinking_label` is the value
 * itself. A value the model does not offer is refused, never mapped nearby.
 */
export function thinkingConfigFor(model: string, value: string): ThinkingConfig {
  if (!generationCatalogEntry(model) || !generationThinkingOptions(model).includes(value)) {
    throw new TeachingPackageError(
      'GENERATION_ROUTE_INVALID',
      `thinking ${JSON.stringify(value)} is not a thinking value of the catalogue model ${JSON.stringify(model)}`,
      { model, thinking: value },
    );
  }
  const { providerId, modelId } = splitModelString(model);
  const control = getCatalogThinkingCapability(providerId, modelId)?.control;
  if (control === 'effort') {
    return value === 'none'
      ? { mode: 'disabled' }
      : { mode: 'enabled', effort: value as ThinkingEffort };
  }
  if (control === 'level') return { mode: 'enabled', level: value as ThinkingLevel };
  return value === 'on' ? { mode: 'enabled' } : { mode: 'disabled' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRouteTarget(raw: unknown, role: 'primary' | 'fallback'): GenerationRouteTarget {
  const invalid = (message: string) =>
    new TeachingPackageError('GENERATION_ROUTE_INVALID', message);
  if (!isPlainObject(raw)) throw invalid(`modelRoute.${role} must be an object`);
  const { model, thinking } = raw;
  if (typeof model !== 'string' || !generationCatalogEntry(model)) {
    throw invalid(
      `modelRoute.${role}.model ${JSON.stringify(model)} is not a Teaching Engine generation catalogue model`,
    );
  }
  const options = generationThinkingOptions(model);
  if (typeof thinking !== 'string' || !options.includes(thinking)) {
    throw invalid(
      `modelRoute.${role}.thinking ${JSON.stringify(thinking)} is not a thinking value of ${model} (allowed: ${options.join(', ')})`,
    );
  }
  return { model, thinking };
}

/**
 * The pure validator behind the request's optional `modelRoute` (D-9, D-11):
 * both targets name a catalogue model and one of its thinking values, the two
 * models differ (D-5), and `settingKey` is a `teaching_generation.route.<CODE>`
 * key. Anything else is refused with `GENERATION_ROUTE_INVALID` (400) before
 * any attempt exists. Returns a fresh value with exactly the wire fields, so
 * an extra key can never reach the digest or the frozen route.
 */
export function parseGenerationModelRoute(raw: unknown): GenerationModelRoute {
  if (!isPlainObject(raw)) {
    throw new TeachingPackageError(
      'GENERATION_ROUTE_INVALID',
      'modelRoute must be an object when present',
    );
  }
  const primary = parseRouteTarget(raw.primary, 'primary');
  const fallback = parseRouteTarget(raw.fallback, 'fallback');
  if (primary.model === fallback.model) {
    throw new TeachingPackageError(
      'GENERATION_ROUTE_INVALID',
      `modelRoute.fallback.model must differ from modelRoute.primary.model (${primary.model})`,
    );
  }
  const { settingKey } = raw;
  if (typeof settingKey !== 'string' || !GENERATION_ROUTE_SETTING_KEY.test(settingKey)) {
    throw new TeachingPackageError(
      'GENERATION_ROUTE_INVALID',
      'modelRoute.settingKey must be a teaching_generation.route.<CODE> setting key',
    );
  }
  return { primary, fallback, settingKey };
}

export type GenerationModelUnavailableReason = 'missing-key' | 'unregistered';

export interface GenerationModelAvailability {
  available: boolean;
  unavailableReason: GenerationModelUnavailableReason | null;
  /** The env var NAME an operator sets on the Teaching Engine; never a key value. */
  keyEnvVar: string;
}

/** `<PREFIX>_API_KEY` from the first `LLM_ENV_MAP` prefix of the provider (never its value). */
function keyEnvVarOf(providerId: string): string {
  const prefix = Object.entries(LLM_ENV_MAP).find(([, id]) => id === providerId)?.[0];
  return prefix ? `${prefix}_API_KEY` : 'the provider API key';
}

/**
 * Server-only availability of a catalogue model: the three checks of
 * `subjectRoutingConfigProblems` (`config-validation.ts`) — provider
 * registered, model registered, and a server key when the provider needs one.
 * Reads operator config only; never returns a key or base URL.
 */
export function generationModelAvailability(model: string): GenerationModelAvailability {
  const { providerId, modelId } = splitModelString(model);
  const keyEnvVar = keyEnvVarOf(providerId);
  const provider = getProvider(providerId as ProviderId);
  if (!provider || !getModelInfo(providerId as ProviderId, modelId)) {
    return { available: false, unavailableReason: 'unregistered', keyEnvVar };
  }
  if (provider.requiresApiKey && !resolveApiKey(providerId)) {
    return { available: false, unavailableReason: 'missing-key', keyEnvVar };
  }
  return { available: true, unavailableReason: null, keyEnvVar };
}

/** Operator-facing message for an unavailable route target (names the env var, never a value). */
export function generationModelUnavailableMessage(
  route: Pick<GenerationModelRoute, 'settingKey'>,
  role: 'primary' | 'fallback',
  model: string,
  availability: GenerationModelAvailability,
): string {
  const where = `Teaching Engine generation route ${route.settingKey}: ${role} model ${model}`;
  if (availability.unavailableReason === 'unregistered') {
    return `${where} is not registered in the provider catalog`;
  }
  return `${where} has no server API key configured (${availability.keyEnvVar})`;
}

export interface GenerationCatalogModel {
  model: string;
  name: string;
  providerId: string;
  available: boolean;
  unavailableReason: GenerationModelUnavailableReason | null;
  keyEnvVar: string;
  /** Image input (registry `capabilities.vision`); the admin notes a model without it. */
  vision: boolean;
  thinking: { options: string[]; default: string };
}

/** Today's code table for one subject, in catalogue values. */
export interface GenerationCatalogDefault {
  subjectCode: SubjectCode;
  primary: GenerationRouteTarget;
  fallback: GenerationRouteTarget;
}

export interface GenerationModelCatalog {
  models: GenerationCatalogModel[];
  defaults: GenerationCatalogDefault[];
}

function sameThinking(a: ThinkingConfig, b: ThinkingConfig): boolean {
  return a.mode === b.mode && a.effort === b.effort && a.level === b.level;
}

/**
 * A table target in catalogue values: the option whose config equals the
 * table's (`{mode:'disabled'}` on Qwen3.7 Flash → `off`, not its ledger label
 * `nothink`). The table label is kept only if no option matches.
 */
function tableTargetOf(target: PolicyTarget): GenerationRouteTarget {
  const match = generationThinkingOptions(target.model).find(
    (option) =>
      generationCatalogEntry(target.model) &&
      sameThinking(thinkingConfigFor(target.model, option), target.thinking),
  );
  return { model: target.model, thinking: match ?? target.label };
}

/**
 * The catalogue the Kafuo admin panel picks from (D-12): the 11 models with
 * their server availability, thinking options and default, and today's code
 * table per subject. Secret-free: no key, base URL or env value is read into it.
 */
export function buildGenerationModelCatalog(): GenerationModelCatalog {
  const models = GENERATION_MODEL_CATALOG.map(
    ({ model, defaultThinking }): GenerationCatalogModel => {
      const { providerId, modelId } = splitModelString(model);
      const info = getModelInfo(providerId as ProviderId, modelId);
      const availability = generationModelAvailability(model);
      return {
        model,
        name: info?.name ?? model,
        providerId,
        available: availability.available,
        unavailableReason: availability.unavailableReason,
        keyEnvVar: availability.keyEnvVar,
        vision: info?.capabilities?.vision === true,
        thinking: { options: [...generationThinkingOptions(model)], default: defaultThinking },
      };
    },
  );
  const defaults = SUBJECT_CODES.map((subjectCode): GenerationCatalogDefault => {
    const policy = SUBJECT_MODEL_POLICY[subjectCode];
    return {
      subjectCode,
      primary: tableTargetOf(policy.primary),
      fallback: tableTargetOf(policy.fallback),
    };
  });
  return { models, defaults };
}
