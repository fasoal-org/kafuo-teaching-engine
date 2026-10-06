/**
 * Subject → Primary → Fallback teaching model policy (Kafuo R1, FRD §14,
 * contracts §1, plan §7.1).
 *
 * This table is CODE-OWNED and frozen: Kafuo never names a model, and no
 * operator config (`MODEL_ROUTES`, `DEFAULT_MODEL`, `x-model`) may shadow it.
 * The one external authority is the shared fixture
 * `docs/frds/model_routing/subject-routing-table.v1.json`, to which
 * `tests/server/subject-model-policy.test.ts` pins this module — a drift in
 * either direction fails that test rather than silently re-routing a subject.
 *
 * Nothing here touches the provider registry or the network: this module is
 * safe to import from validation code that runs before any client exists.
 * Resolution against the registry lives in `resolve-policy.ts`.
 */
import type { ThinkingConfig } from '@/lib/types/provider';

export const POLICY_VERSION = 'r1-2026-09';

export const SUBJECT_CODES = [
  'MATH',
  'PHYSICS',
  'BIOLOGY',
  'ARABIC',
  'SOCIAL_STUDIES',
  'CHEMISTRY',
  'ENGLISH',
] as const;

export type SubjectCode = (typeof SUBJECT_CODES)[number];

/** The canonical model strings the policy is allowed to name. */
export const POLICY_MODEL_STRINGS = [
  'qwen:qwen3.7-flash',
  'openai:gpt-5-nano',
  'openai:gpt-5.6-luna',
  'openai:gpt-6-luna',
] as const;

export type PolicyModelString = (typeof POLICY_MODEL_STRINGS)[number];

export interface PolicyTarget {
  readonly model: PolicyModelString;
  /** The full unified thinking config the executor passes to callLLM/streamLLM. */
  readonly thinking: ThinkingConfig;
  /** Human label persisted on the ledger row (`thinking_label`). */
  readonly label: string;
}

export interface SubjectPolicyEntry {
  readonly primary: PolicyTarget;
  readonly fallback: PolicyTarget;
}

const QWEN_NOTHINK: PolicyTarget = Object.freeze({
  model: 'qwen:qwen3.7-flash',
  thinking: Object.freeze({ mode: 'disabled' }) as ThinkingConfig,
  label: 'nothink',
});

const LUNA_LOW: PolicyTarget = Object.freeze({
  model: 'openai:gpt-5.6-luna',
  thinking: Object.freeze({ mode: 'enabled', effort: 'low' }) as ThinkingConfig,
  label: 'low',
});

function entry(primary: PolicyTarget, fallback: PolicyTarget): SubjectPolicyEntry {
  return Object.freeze({ primary, fallback });
}

/**
 * The approved routing table. Deep-frozen so no runtime path — a request
 * handler, a test, a hot-reloaded module — can mutate the policy in place.
 */
export const SUBJECT_MODEL_POLICY: Readonly<Record<SubjectCode, SubjectPolicyEntry>> =
  Object.freeze({
    MATH: entry(LUNA_LOW, QWEN_NOTHINK),
    PHYSICS: entry(LUNA_LOW, QWEN_NOTHINK),
    BIOLOGY: entry(LUNA_LOW, QWEN_NOTHINK),
    ARABIC: entry(LUNA_LOW, QWEN_NOTHINK),
    SOCIAL_STUDIES: entry(LUNA_LOW, QWEN_NOTHINK),
    CHEMISTRY: entry(LUNA_LOW, QWEN_NOTHINK),
    // Product decision 28 Sep 2026: English takes the same route as the other six.
    ENGLISH: entry(LUNA_LOW, QWEN_NOTHINK),
  });

export function isSubjectCode(value: unknown): value is SubjectCode {
  return typeof value === 'string' && (SUBJECT_CODES as readonly string[]).includes(value);
}

export type SubjectRoutingMode = 'enforced' | 'off';

/**
 * `TEACHING_SUBJECT_ROUTING=enforced|off`. Read at call time (not cached) so
 * boot validation and tests observe the environment they run under; the
 * `ROUTING_MODE` constant below is the same value captured at module load for
 * callers that want a stable per-process answer.
 *
 * Anything other than the literal `off` is treated as `enforced`: an unknown
 * value must fail closed, never silently disable routing (ROUTE-01).
 */
export function readRoutingMode(
  env: Record<string, string | undefined> = process.env,
): SubjectRoutingMode {
  return env.TEACHING_SUBJECT_ROUTING?.trim().toLowerCase() === 'off' ? 'off' : 'enforced';
}

export const ROUTING_MODE: SubjectRoutingMode = readRoutingMode();

/**
 * Which budget counter a model uses (contracts §8): the OpenAI models tokenize
 * with `o200k_base`, so their count is exact; every other provider (Qwen) is
 * counted with the calibrated proxy. Keyed by provider id so the executor and
 * the budget module agree without either importing the tokenizer.
 */
export type CounterKind = 'exact' | 'proxy';

export function counterKindForProvider(providerId: string): CounterKind {
  return providerId === 'openai' ? 'exact' : 'proxy';
}

/** Every distinct model string the policy names (for boot validation). */
export function policyModelStrings(): PolicyModelString[] {
  const seen = new Set<PolicyModelString>();
  for (const code of SUBJECT_CODES) {
    seen.add(SUBJECT_MODEL_POLICY[code].primary.model);
    seen.add(SUBJECT_MODEL_POLICY[code].fallback.model);
  }
  return [...seen];
}
