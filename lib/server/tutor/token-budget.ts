/**
 * Input budget counters (Kafuo R1 contracts §8, plan §8.7).
 *
 * | counter | models                          | basis                                   | margin | cap    |
 * | exact   | openai:gpt-5-nano, gpt-5.6-luna | js-tiktoken o200k_base + framing        | 6 %    | 30,080 |
 * | proxy   | qwen:qwen3.7-flash              | exact count × proxy_ratio (calibrated)  | 20 %   | 25,600 |
 *
 * The count is over the SERIALIZED MESSAGE TEXTS the executor hands to the
 * provider (system + every message), plus the framing overhead the
 * calibration validated (5 tokens per message + 3 per request — see
 * token-calibration-seed.ts). It is deliberately conservative: on the
 * benchmark corpora the exact count is ≥ the provider's `prompt_tokens` on
 * 100 % of turns, so a request that passes the assertion cannot exceed
 * HARD_CAP at the provider.
 *
 * The assembler enforces the TIGHTER of the subject pair's two caps
 * (`tighterCapForPolicy`) so a fallback never fails the executor assertion.
 * The tokenizer is loaded lazily and memoized: o200k_base ranks are a few MB
 * and only conversational calls need them.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken';

import type { CounterKind } from '@/lib/server/teaching-model/subject-policy';
import {
  DEFAULT_PROXY_RATIO,
  FRAMING_FIXED,
  FRAMING_PER_MESSAGE,
  SEED_PROXY_RATIO,
} from '@/lib/server/tutor/token-calibration-seed';

export const HARD_CAP = 32_000;
export const UNIT_CHAR_CAP = 10_000;
export const EXACT_MARGIN = 0.06;
export const PROXY_MARGIN = 0.2;
export const FRAMING = Object.freeze({ perMessage: FRAMING_PER_MESSAGE, fixed: FRAMING_FIXED });

export function effectiveCap(counterKind: CounterKind): number {
  const margin = counterKind === 'exact' ? EXACT_MARGIN : PROXY_MARGIN;
  return Math.floor(HARD_CAP * (1 - margin));
}

/**
 * The narrowest message shape the counter needs: the AI SDK's `ModelMessage`
 * (string content, or an array of typed parts) satisfies it structurally.
 */
export interface BudgetMessage {
  role: string;
  content: string | ReadonlyArray<{ type: string; text?: string }>;
}

let encoder: Tiktoken | undefined;
function o200k(): Tiktoken {
  return (encoder ??= getEncoding('o200k_base'));
}

/** The text the provider will tokenize for one message (non-text parts count 0). */
export function extractMessageText(message: BudgetMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** The exact o200k_base count over every message text plus framing. */
export function countExactTokens(messages: ReadonlyArray<BudgetMessage>): number {
  const enc = o200k();
  let sum = 0;
  for (const message of messages) {
    const text = extractMessageText(message);
    if (text) sum += enc.encode(text).length;
  }
  return sum + FRAMING.perMessage * messages.length + FRAMING.fixed;
}

/** Turn `{ system?, messages?, prompt? }` into the list the provider sees. */
export function budgetMessagesOf(params: {
  system?: string;
  messages?: ReadonlyArray<BudgetMessage>;
  prompt?: string;
}): BudgetMessage[] {
  const list: BudgetMessage[] = [];
  if (params.system) list.push({ role: 'system', content: params.system });
  if (params.messages) list.push(...params.messages);
  else if (params.prompt) list.push({ role: 'user', content: params.prompt });
  return list;
}

/**
 * Count with the target's counter. `proxyRatio` is the calibrated ratio for a
 * proxy model (from `teaching_model_calibration`, seeded from the calibration
 * file); absent, the seed or the conservative default applies.
 */
export function countTokens(
  messages: ReadonlyArray<BudgetMessage>,
  counterKind: CounterKind,
  modelString: string,
  options: { proxyRatio?: number | null } = {},
): number {
  const exact = countExactTokens(messages);
  if (counterKind === 'exact') return exact;
  const ratio = options.proxyRatio ?? seedProxyRatio(modelString);
  return Math.ceil(exact * ratio);
}

export function seedProxyRatio(modelString: string): number {
  return SEED_PROXY_RATIO[modelString] ?? DEFAULT_PROXY_RATIO;
}

/** Async source of the live ratio (the calibration table); null = not calibrated. */
export type ProxyRatioReader = (modelString: string) => Promise<number | null>;

/** The ratio to count with: live value if present, never below the seed. */
export async function resolveProxyRatio(
  modelString: string,
  reader?: ProxyRatioReader,
): Promise<number> {
  const seed = seedProxyRatio(modelString);
  if (!reader) return seed;
  const live = await reader(modelString);
  return live === null || !Number.isFinite(live) ? seed : Math.max(seed, live);
}

/** The tighter of the pair's caps: what the assembler must stay under. */
export function tighterCapForPolicy(policy: {
  primary: { counterKind: CounterKind };
  fallback: { counterKind: CounterKind };
}): number {
  return Math.min(
    effectiveCap(policy.primary.counterKind),
    effectiveCap(policy.fallback.counterKind),
  );
}
