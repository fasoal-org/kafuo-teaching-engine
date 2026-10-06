import { APICallError, NoContentGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  classifyError,
  classifyResult,
  FALLBACK_ELIGIBLE,
  isDashScopeInspectionFailure,
} from '@/lib/server/teaching-model/classify-failure';
import {
  checkTextRenderability,
  checkStructuredOutput,
} from '@/lib/server/teaching-model/renderability';
import { ATTEMPT_OUTCOMES } from '@/lib/persistence/teaching-model-attempts';

/** Plan §7.3 classification table, row by row (ROUTE-02). */

const live = { timedOut: false, callerAborted: false };

function apiError(
  statusCode: number,
  extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
    ...extra,
  });
}

describe('FALLBACK_ELIGIBLE covers every outcome exactly as ROUTE-02 says', () => {
  it('has one entry per ledger outcome', () => {
    expect(Object.keys(FALLBACK_ELIGIBLE).sort()).toEqual([...ATTEMPT_OUTCOMES].sort());
  });
  it('technical failures and unrenderable output fall back; refusals, aborts and our defects do not', () => {
    expect(FALLBACK_ELIGIBLE).toEqual({
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
  });
});

describe('classifyError', () => {
  it('429 → rate_limited (fallback)', () => {
    expect(classifyError(apiError(429), live)).toMatchObject({
      outcome: 'rate_limited',
      fallbackEligible: true,
      errorStatus: 429,
    });
  });

  it('408/409/425/5xx → provider_error (fallback)', () => {
    for (const status of [408, 409, 425, 500, 502, 503, 529]) {
      expect(classifyError(apiError(status), live), String(status)).toMatchObject({
        outcome: 'provider_error',
        fallbackEligible: true,
        errorStatus: status,
      });
    }
  });

  it('401/403/404 → provider_error with error_code=config (fallback)', () => {
    for (const status of [401, 403, 404]) {
      expect(classifyError(apiError(status), live)).toMatchObject({
        outcome: 'provider_error',
        fallbackEligible: true,
        errorCode: 'config',
        errorStatus: status,
      });
    }
  });

  it('SDK isRetryable without a status → provider_error (fallback)', () => {
    const error = new APICallError({
      message: 'transient',
      url: 'u',
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(classifyError(error, live)).toMatchObject({
      outcome: 'provider_error',
      fallbackEligible: true,
    });
  });

  it('network / DNS errors → provider_error (fallback)', () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    });
    expect(classifyError(dns, live)).toMatchObject({
      outcome: 'provider_error',
      fallbackEligible: true,
    });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyError(reset, live)).toMatchObject({
      outcome: 'provider_error',
      errorCode: 'ECONNRESET',
    });
  });

  it('our timeout fired → timeout (fallback), even when the error looks like an abort', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyError(abort, { timedOut: true, callerAborted: false })).toMatchObject({
      outcome: 'timeout',
      fallbackEligible: true,
    });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    expect(classifyError(timeout, live).outcome).toBe('timeout');
  });

  it('caller abort → aborted (no fallback)', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyError(abort, { timedOut: false, callerAborted: true })).toMatchObject({
      outcome: 'aborted',
      fallbackEligible: false,
    });
    expect(classifyError(abort, live).outcome).toBe('aborted');
  });

  it('DashScope DataInspectionFailed (400) → provider_content_filter (fallback, AMB-06)', () => {
    const byBody = apiError(400, {
      responseBody:
        '{"error":{"code":"DataInspectionFailed","message":"Output data may contain inappropriate content."}}',
    });
    expect(isDashScopeInspectionFailure(byBody)).toBe(true);
    expect(classifyError(byBody, live)).toMatchObject({
      outcome: 'provider_content_filter',
      fallbackEligible: true,
      errorCode: 'DataInspectionFailed',
      errorStatus: 400,
    });
    const byMessage = apiError(400, { message: 'data_inspection_failed: inappropriate content' });
    expect(classifyError(byMessage, live).outcome).toBe('provider_content_filter');
    const byData = apiError(400, { data: { error: { code: 'DataInspectionFailed' } } });
    expect(classifyError(byData, live).outcome).toBe('provider_content_filter');
  });

  it('other 400/413/422 → request_rejected (no fallback: our defect)', () => {
    for (const status of [400, 413, 422]) {
      expect(
        classifyError(apiError(status, { message: 'context length exceeded' }), live),
      ).toMatchObject({
        outcome: 'request_rejected',
        fallbackEligible: false,
        errorStatus: status,
      });
    }
  });

  it('NoContentGeneratedError → empty_output (fallback)', () => {
    expect(classifyError(new NoContentGeneratedError({}), live)).toMatchObject({
      outcome: 'empty_output',
      fallbackEligible: true,
    });
  });

  it('duck-typed SDK error shapes (other module graphs) classify identically', () => {
    const shaped = {
      name: 'AI_APICallError',
      statusCode: 429,
      message: 'rate limited',
      isRetryable: true,
    };
    expect(classifyError(shaped, live).outcome).toBe('rate_limited');
    expect(classifyError({ name: 'AI_NoContentGeneratedError', message: 'x' }, live).outcome).toBe(
      'empty_output',
    );
  });

  it('an unknown throw is a technical failure of the route (fallback)', () => {
    expect(classifyError(new Error('boom'), live)).toMatchObject({
      outcome: 'provider_error',
      fallbackEligible: true,
      errorCode: 'unknown',
      errorMessage: 'boom',
    });
  });
});

describe('classifyResult', () => {
  it('finishReason content-filter → safety_refused (never overridden by a fallback)', () => {
    expect(
      classifyResult({
        text: 'partial',
        finishReason: 'content-filter',
        renderable: true,
        structuredValid: null,
      }),
    ).toMatchObject({
      outcome: 'safety_refused',
      fallbackEligible: false,
    });
  });

  it('empty text → empty_output (fallback)', () => {
    expect(
      classifyResult({
        text: '  \n\t ',
        finishReason: 'stop',
        renderable: false,
        structuredValid: null,
      }),
    ).toMatchObject({
      outcome: 'empty_output',
      fallbackEligible: true,
    });
  });

  it('unparsable / schema-invalid structured output → unusable_output (fallback), truncated flagged', () => {
    expect(
      classifyResult({
        text: '{"a":',
        finishReason: 'stop',
        renderable: true,
        structuredValid: false,
        structuredError: 'Unexpected end',
      }),
    ).toMatchObject({
      outcome: 'unusable_output',
      fallbackEligible: true,
      errorCode: 'unparsable',
      errorMessage: 'Unexpected end',
    });
    expect(
      classifyResult({
        text: '{"a":',
        finishReason: 'length',
        renderable: true,
        structuredValid: false,
      }),
    ).toMatchObject({ outcome: 'unusable_output', errorCode: 'truncated' });
  });

  it('unrenderable free text → unusable_output (fallback); truncated-but-usable text succeeds', () => {
    expect(
      classifyResult({
        text: '<div></div>',
        finishReason: 'stop',
        renderable: false,
        structuredValid: null,
      }),
    ).toMatchObject({
      outcome: 'unusable_output',
      fallbackEligible: true,
    });
    expect(
      classifyResult({
        text: 'الجواب هو 4 لأن',
        finishReason: 'length',
        renderable: true,
        structuredValid: null,
      }).outcome,
    ).toBe('succeeded');
  });

  it('parsable, renderable but weak output → succeeded (never a quality comparison)', () => {
    expect(
      classifyResult({
        text: 'نعم.',
        finishReason: 'stop',
        renderable: true,
        structuredValid: null,
      }),
    ).toMatchObject({
      outcome: 'succeeded',
      fallbackEligible: false,
      errorCode: null,
    });
    expect(
      classifyResult({ text: '{}', finishReason: 'stop', renderable: true, structuredValid: true })
        .outcome,
    ).toBe('succeeded');
  });
});

describe('renderability', () => {
  it('rejects empty, markup-only and garbage text; accepts short real answers in any script', () => {
    expect(checkTextRenderability('')).toEqual({ renderable: false, reason: 'empty' });
    expect(checkTextRenderability('<p></p> ``` ``` ---')).toEqual({
      renderable: false,
      reason: 'markup_only',
    });
    expect(checkTextRenderability('���ab�')).toEqual({ renderable: false, reason: 'garbage' });
    expect(checkTextRenderability('42')).toEqual({ renderable: true, reason: 'ok' });
    expect(checkTextRenderability('التبرير الاستقرائي هو الاستنتاج من الأمثلة.').renderable).toBe(
      true,
    );
    expect(checkTextRenderability('**Bold** point with a [link](x) and `code`').renderable).toBe(
      true,
    );
    // One stray replacement char in a long answer is not garbage.
    expect(checkTextRenderability(`${'الشرح الكامل للدرس '.repeat(10)}�`).renderable).toBe(true);
  });

  it('checkStructuredOutput turns a throwing validate into an unusable verdict, never a crash', () => {
    expect(checkStructuredOutput('{"ok":true}', (t) => JSON.parse(t))).toEqual({
      ok: true,
      parsed: { ok: true },
    });
    expect(checkStructuredOutput('{"ok":', (t) => JSON.parse(t))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(checkStructuredOutput('   ', (t) => JSON.parse(t))).toMatchObject({
      ok: false,
      reason: 'empty',
    });
    expect(
      checkStructuredOutput('{"ok":true}', () => {
        throw new Error('schema: missing "scenes"');
      }),
    ).toEqual({ ok: false, reason: 'invalid', error: 'schema: missing "scenes"' });
  });
});
