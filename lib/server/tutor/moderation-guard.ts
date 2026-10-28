/**
 * Input moderation for tutor turns (guardrails review 28 Oct 2026, §5d Layer 2).
 *
 * The Teaching Engine port of the Kafuo backend `tutor_safety` input check: the
 * student message goes to OpenAI `omni-moderation-latest` before any model call.
 *
 *  - a `self-harm*` category → a fixed supportive reply, never the generic refusal;
 *  - any other flagged category → the backend's fixed refusal wording, unless the
 *    experiment guard already triggered (its directive and post-check own that turn);
 *  - unreachable, timeout or an unreadable body → `unavailable`: the turn goes on under
 *    the tutor rules alone (owner decision, 28 Oct 2026) and the log says so.
 *
 * `TUTOR_MODERATION_ENABLED=false` switches the check off. The key and base URL are
 * the server-managed `openai` provider's, never a client key. Nothing here logs the
 * student's text.
 */
import { createLogger } from '@/lib/logger';
import { resolveApiKey, resolveBaseUrl } from '@/lib/server/provider-config';
import { proxyFetch } from '@/lib/server/proxy-fetch';

const log = createLogger('TutorModeration');

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const MODERATION_MODEL = 'omni-moderation-latest';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 3000;

export type ModerationVerdict =
  | { outcome: 'clear' }
  | { outcome: 'self_harm'; categories: string[] }
  | { outcome: 'flagged'; categories: string[] }
  | { outcome: 'unavailable'; kind: string };

/** One moderation call for the student's message. Never throws. */
export type ModerationCheck = (text: string) => Promise<ModerationVerdict>;

export function isModerationEnabled(env: Env = process.env): boolean {
  return env.TUTOR_MODERATION_ENABLED?.trim().toLowerCase() !== 'false';
}

export function moderationTimeoutMs(env: Env = process.env): number {
  const value = Number(env.TUTOR_MODERATION_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** The OpenAI moderation body → a verdict. Self-harm wins over every other category. */
export function classifyModeration(body: unknown): ModerationVerdict {
  const result = (body as { results?: Array<{ flagged?: unknown; categories?: unknown }> } | null)
    ?.results?.[0];
  if (!result || typeof result.flagged !== 'boolean') {
    return { outcome: 'unavailable', kind: 'invalid_body' };
  }
  const categories =
    result.categories && typeof result.categories === 'object'
      ? Object.entries(result.categories as Record<string, unknown>)
          .filter(([, value]) => value === true)
          .map(([name]) => name)
      : [];
  const selfHarm = categories.filter((name) => name.startsWith('self-harm'));
  if (selfHarm.length) return { outcome: 'self_harm', categories: selfHarm };
  if (result.flagged) return { outcome: 'flagged', categories };
  return { outcome: 'clear' };
}

export interface ModerationCheckOptions {
  fetch?: FetchLike;
  credentials?: () => { apiKey: string; baseUrl?: string };
  timeoutMs?: () => number;
}

export function createModerationCheck(options: ModerationCheckOptions = {}): ModerationCheck {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => proxyFetch(url, init));
  const credentials =
    options.credentials ??
    (() => ({ apiKey: resolveApiKey('openai'), baseUrl: resolveBaseUrl('openai') }));
  const timeoutMs = options.timeoutMs ?? (() => moderationTimeoutMs());

  return async (text) => {
    const { apiKey, baseUrl } = credentials();
    if (!apiKey) return { outcome: 'unavailable', kind: 'no_api_key' };
    let response: Response;
    try {
      response = await doFetch(
        `${(baseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '')}/moderations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
          signal: AbortSignal.timeout(timeoutMs()),
        },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      return {
        outcome: 'unavailable',
        kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      };
    }
    if (!response.ok) return { outcome: 'unavailable', kind: `http_${response.status}` };
    try {
      return classifyModeration(await response.json());
    } catch {
      return { outcome: 'unavailable', kind: 'invalid_body' };
    }
  };
}

const CHECK_KEY = Symbol.for('openmaic.tutor.moderation-check');

/** The process-wide check, or `null` when `TUTOR_MODERATION_ENABLED=false`. */
export function getModerationCheck(env: Env = process.env): ModerationCheck | null {
  if (!isModerationEnabled(env)) return null;
  const registry = globalThis as Record<symbol, ModerationCheck | undefined>;
  return (registry[CHECK_KEY] ??= createModerationCheck());
}

/**
 * Run the check for one turn. `null` / absent check → `clear`; a throwing check →
 * `unavailable` (fail open, logged). Logs categories and the failure kind only.
 */
export async function moderateTurn(
  check: ModerationCheck | null | undefined,
  text: string,
  turnId: string,
): Promise<ModerationVerdict> {
  if (!check) return { outcome: 'clear' };
  let verdict: ModerationVerdict;
  try {
    verdict = await check(text);
  } catch (error) {
    verdict = { outcome: 'unavailable', kind: error instanceof Error ? error.name : 'error' };
  }
  if (verdict.outcome === 'unavailable') {
    log.warn(JSON.stringify({ event: 'tutor.moderation_unavailable', turnId, kind: verdict.kind }));
  } else if (verdict.outcome !== 'clear') {
    log.info(
      JSON.stringify({
        event: 'tutor.moderation_flagged',
        turnId,
        outcome: verdict.outcome,
        categories: verdict.categories,
      }),
    );
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Fixed replies
// ---------------------------------------------------------------------------

/** Supportive reply when the student's message points to self-harm (G-2). */
export const SELF_HARM_SUPPORT_MESSAGE_AR = `شكرًا إنك قلت لي، ويهمّني إنك تكون بخير. اللي تحس فيه مهم، وما لازم تشيله لحالك. كلّم الحين أحد من أهلك أو معلمك أو المرشد الطلابي أو أي شخص كبير تثق فيه، وقل له اللي قلته لي. وإذا كنت في خطر الحين، قل لأقرب شخص كبير جنبك فورًا. وأنا موجود هنا متى ما حبيت نرجع نذاكر.`;

export const SELF_HARM_SUPPORT_MESSAGE_EN = `Thank you for telling me, and I care that you're okay. What you're feeling matters, and you don't have to carry it alone. Please talk right now to a parent, a teacher, your school counsellor or another adult you trust, and tell them what you told me. If you are in danger right now, tell the nearest adult straight away. I'm here whenever you want to get back to studying.`;

/** The backend's `unsafe_input_fallback` wording, with «المادة» (Free Chat never says «الدرس»). */
export const MODERATION_REFUSAL_MESSAGE_AR = 'ما أقدر أساعدك بهالطلب. تبغى نرجع لموضوع المادة؟';

export const MODERATION_REFUSAL_MESSAGE_EN =
  "I can't help with that request. Would you like to get back to the subject?";

/**
 * The fixed reply for a verdict, or `null` when the model answers. A `flagged` turn
 * that the experiment guard already caught is left to the guard's directive and
 * post-check, which keep the learning goal instead of refusing outright.
 */
export function moderationReply(
  verdict: ModerationVerdict,
  experimentTriggered: boolean,
  language: 'ar' | 'en',
): { text: string; reason: 'moderation_self_harm' | 'moderation_flagged' } | null {
  if (verdict.outcome === 'self_harm') {
    return {
      text: language === 'en' ? SELF_HARM_SUPPORT_MESSAGE_EN : SELF_HARM_SUPPORT_MESSAGE_AR,
      reason: 'moderation_self_harm',
    };
  }
  if (verdict.outcome === 'flagged' && !experimentTriggered) {
    return {
      text: language === 'en' ? MODERATION_REFUSAL_MESSAGE_EN : MODERATION_REFUSAL_MESSAGE_AR,
      reason: 'moderation_flagged',
    };
  }
  return null;
}
