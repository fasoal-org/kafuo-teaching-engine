/**
 * Failure classification for the teaching executor (Kafuo R1 plan §7.3,
 * ROUTE-02: fallback only on technical failure or empty/unrenderable output,
 * never on quality).
 *
 * | condition                                                     | outcome                  | fallback |
 * | HTTP 408/409/425/429/5xx, SDK isRetryable, network/DNS errors | provider_error / rate_limited | yes |
 * | our timeout fired                                             | timeout                  | yes      |
 * | 401/403/404 (provider misconfigured)                          | provider_error (code=config, loud) | yes |
 * | DashScope `DataInspectionFailed` on input our guard passed    | provider_content_filter  | yes      |
 * | other 400/413/422 (e.g. context too long despite the budget)  | request_rejected         | no       |
 * | finishReason === 'content-filter' on OUTPUT                   | safety_refused           | no       |
 * | empty text / NoContentGeneratedError / stream with no text    | empty_output             | yes      |
 * | unparsable or schema-invalid structured output, truncated with nothing usable, unrenderable free text | unusable_output | yes |
 * | parsable, renderable, merely weak                             | succeeded                | no       |
 * | stream `error` part                                           | provider_error           | yes      |
 * | caller abort                                                  | aborted                  | no       |
 * | executor budget assertion                                     | budget_assertion_failed  | no       |
 *
 * Error detection is duck-typed on the AI SDK's error shapes (`name`,
 * `statusCode`, `isRetryable`, `responseBody`) in addition to `isInstance`,
 * because the app answers requests from more than one module graph and an
 * `instanceof` across copies is false while the shape is exactly right.
 */
import { APICallError, NoContentGeneratedError } from 'ai';

import type { AttemptOutcome } from '@/lib/persistence/teaching-model-attempts';

export type { AttemptOutcome };

export interface Classification {
  outcome: AttemptOutcome;
  fallbackEligible: boolean;
  errorCode: string | null;
  errorStatus: number | null;
  errorMessage: string | null;
}

/** ROUTE-02, row by row. */
export const FALLBACK_ELIGIBLE: Readonly<Record<AttemptOutcome, boolean>> = Object.freeze({
  succeeded: false,
  empty_output: true,
  unusable_output: true,
  provider_error: true,
  rate_limited: true,
  timeout: true,
  provider_content_filter: true,
  request_rejected: false,
  safety_refused: false,
  aborted: false,
  budget_assertion_failed: false,
});

function classification(
  outcome: AttemptOutcome,
  error: { code?: string | null; status?: number | null; message?: string | null } = {},
): Classification {
  return {
    outcome,
    fallbackEligible: FALLBACK_ELIGIBLE[outcome],
    errorCode: error.code ?? null,
    errorStatus: error.status ?? null,
    errorMessage: error.message ?? null,
  };
}

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  isRetryable?: unknown;
  responseBody?: unknown;
  data?: unknown;
  cause?: unknown;
}

function shape(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? (error as ErrorShape) : {};
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const m = shape(error).message;
  return typeof m === 'string' ? m : String(error ?? '');
}

function statusOf(error: unknown): number | null {
  const s = shape(error);
  for (const candidate of [s.statusCode, s.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function isApiCallError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return true;
  return shape(error).name === 'AI_APICallError';
}

function isNoContentError(error: unknown): boolean {
  if (NoContentGeneratedError.isInstance(error)) return true;
  return shape(error).name === 'AI_NoContentGeneratedError';
}

/**
 * DashScope refuses input its own inspection dislikes with HTTP 400 and
 * `code: "DataInspectionFailed"` (observed on benign chemistry, plan §2.4).
 * It is not our safety decision — our guard already passed the message — so
 * the fallback route gets to answer (AMB-06).
 */
export function isDashScopeInspectionFailure(error: unknown): boolean {
  const s = shape(error);
  const haystack = [
    typeof s.code === 'string' ? s.code : '',
    typeof s.responseBody === 'string' ? s.responseBody : '',
    messageOf(error),
    typeof s.data === 'object' && s.data !== null ? JSON.stringify(s.data) : '',
  ]
    .join('\n')
    .toLowerCase();
  return (
    haystack.includes('datainspectionfailed') ||
    haystack.includes('data_inspection_failed') ||
    haystack.includes('inappropriate content')
  );
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isNetworkError(error: unknown): boolean {
  const s = shape(error);
  const code = typeof s.code === 'string' ? s.code : undefined;
  if (code && NETWORK_CODES.has(code)) return true;
  const causeCode =
    typeof shape(s.cause).code === 'string' ? (shape(s.cause).code as string) : undefined;
  if (causeCode && NETWORK_CODES.has(causeCode)) return true;
  const message = messageOf(error).toLowerCase();
  return (
    message === 'fetch failed' ||
    message.includes('network error') ||
    message.includes('socket hang up')
  );
}

function isAbortError(error: unknown): boolean {
  const s = shape(error);
  return s.name === 'AbortError' || (typeof s.code === 'string' && s.code === 'ABORT_ERR');
}

function isTimeoutError(error: unknown): boolean {
  return shape(error).name === 'TimeoutError';
}

export interface ClassifyErrorContext {
  /** Our `AbortSignal.timeout(totalMs)` fired. */
  timedOut: boolean;
  /** The caller's `ctx.signal` is aborted. */
  callerAborted: boolean;
}

/** Classify a thrown error from `callLLM` / `streamLLM` or a stream `error` part. */
export function classifyError(error: unknown, context: ClassifyErrorContext): Classification {
  const message = messageOf(error);
  // Abort and timeout share the DOM AbortError shape; the signals tell them apart.
  if (context.callerAborted) return classification('aborted', { code: 'aborted', message });
  if (context.timedOut || isTimeoutError(error))
    return classification('timeout', { code: 'timeout', message });
  if (isAbortError(error)) return classification('aborted', { code: 'aborted', message });

  if (isNoContentError(error))
    return classification('empty_output', { code: 'no_content', message });

  const status = statusOf(error);
  if (isApiCallError(error) || status !== null) {
    if (status === 429) return classification('rate_limited', { code: '429', status, message });
    if (status === 408 || status === 409 || status === 425 || (status !== null && status >= 500)) {
      return classification('provider_error', { code: String(status), status, message });
    }
    if (status === 401 || status === 403 || status === 404) {
      return classification('provider_error', { code: 'config', status, message });
    }
    if (status === 400 || status === 413 || status === 422) {
      if (isDashScopeInspectionFailure(error)) {
        return classification('provider_content_filter', {
          code: 'DataInspectionFailed',
          status,
          message,
        });
      }
      return classification('request_rejected', { code: String(status), status, message });
    }
    if (shape(error).isRetryable === true) {
      return classification('provider_error', { code: 'retryable', status, message });
    }
    if (status !== null) {
      // Any other 4xx the SDK surfaced: our request was not accepted.
      return classification('request_rejected', { code: String(status), status, message });
    }
  }
  if (isNetworkError(error)) {
    const code = typeof shape(error).code === 'string' ? (shape(error).code as string) : 'network';
    return classification('provider_error', { code, message });
  }
  // Unknown throw: a technical failure of this route, not a judgement on the
  // output — the fallback may still answer.
  return classification('provider_error', { code: 'unknown', message });
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | undefined;

export interface ClassifyResultInput {
  text: string;
  finishReason: FinishReason;
  /** Free-text renderability verdict (renderability.ts); ignored for structured output. */
  renderable: boolean;
  /** Structured output: `null` = text mode; otherwise whether validate() accepted the text. */
  structuredValid: boolean | null;
  structuredError?: string | null;
}

/** Classify a completed (non-throwing) attempt's output. */
export function classifyResult(input: ClassifyResultInput): Classification {
  if (input.finishReason === 'content-filter') {
    return classification('safety_refused', { code: 'content-filter' });
  }
  if (input.text.trim().length === 0) {
    return classification('empty_output', {
      code: input.finishReason === 'length' ? 'length' : 'empty',
    });
  }
  if (input.structuredValid === false) {
    return classification('unusable_output', {
      code: input.finishReason === 'length' ? 'truncated' : 'unparsable',
      message: input.structuredError ?? null,
    });
  }
  if (input.structuredValid === null && !input.renderable) {
    return classification('unusable_output', {
      code: input.finishReason === 'length' ? 'truncated' : 'unrenderable',
    });
  }
  return classification('succeeded');
}
