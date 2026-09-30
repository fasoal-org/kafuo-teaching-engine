import { APICallError } from 'ai';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { beginLegacyHelpTurn, readLegacyHelpTurn } from '@/lib/persistence/legacy-help-turns';
import { readAttempt, type TeachingModelAttemptRow } from '@/lib/persistence/teaching-model-attempts';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { computeHelpTurnDigest } from '@/lib/server/tutor/canonical-json';
import { SAFETY_BOUNDARY_MESSAGE } from '@/lib/server/tutor/experiment-guard';
import { countTokens, effectiveCap } from '@/lib/server/tutor/token-budget';

import { createTutorPool, ok, RecordingPool, STUDENT_REF, T0_MS } from './tutor-test-harness';

/**
 * `POST /api/teaching-model/help-turns` (contracts §3.4; plan §8.8, P6
 * `legacy-help-turns` tests). The Kafuo integration client is mocked to
 * THROW on construction and on `getKafuoIntegrationClient`: this path never
 * reserves, finalizes or searches — the Backend meters in-process.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  events: [] as string[],
  clientConstructed: 0,
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return { model: { provider: providerId, modelId }, modelInfo: providers.getModelInfo(providerId, modelId), modelString, providerId, modelId, apiKey: 'k' };
    },
  };
});
vi.mock('@/lib/server/tutor/kafuo-integration-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/tutor/kafuo-integration-client')>();
  class Forbidden {
    constructor() {
      mocks.clientConstructed += 1;
      throw new Error('the legacy help path must never construct the Kafuo client');
    }
  }
  return {
    ...actual,
    KafuoIntegrationClient: Forbidden,
    getKafuoIntegrationClient: () => {
      mocks.clientConstructed += 1;
      throw new Error('the legacy help path must never use the Kafuo client');
    },
  };
});
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const SERVICE_KEY = 'legacy-help-svc-key';
let t = T0_MS;
const now = () => t;

function apiError(statusCode: number) {
  return new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider.example', requestBodyValues: {}, statusCode, isRetryable: statusCode === 429 || statusCode >= 500 });
}

const UNIT_TEXT = 'القوة = الكتلة × التسارع. هذا هو قانون نيوتن الثاني، ويُقاس بالنيوتن.';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tenantContext: { tenantId: '1' },
    origin: 'kafuo_backend',
    turnId: 'kafuo:conv:123:cm-abc',
    studentRef: STUDENT_REF,
    subject: { code: 'PHYSICS', nameAr: 'الفيزياء', nameEn: 'Physics', academicLanguage: 'ar' },
    academic: { curriculumName: 'المنهج الوطني', curriculumVersionLabel: '2026', gradeLabel: 'الصف التاسع' },
    lesson: { learningItemType: 'lesson', learningItemId: '77', title: 'قانون نيوتن الثاني' },
    helpScope: { kind: 'help_linked_chat', label: 'مساعدة', cardKey: null, stepNumber: null, intent: null },
    grounding: { units: [{ unitId: 'u-1', title: 'القوة والتسارع', text: UNIT_TEXT, charLength: UNIT_TEXT.length }], truncated: false },
    history: [
      { role: 'student', text: 'ما هو القانون؟' },
      { role: 'tutor', text: 'القانون يربط القوة بالتسارع.' },
    ],
    message: { text: 'اشرح لي مثالاً بسيطاً' },
    localeHint: 'ar',
    legacyHelpLinkRef: 'link:55',
    actorRef: 'actor-1',
    ...overrides,
  };
  return { ...base, requestDigest: computeHelpTurnDigest(base) };
}

async function post(payload: unknown, auth: string | null = `Bearer ${SERVICE_KEY}`) {
  const { POST } = await import('@/app/api/teaching-model/help-turns/route');
  return POST(
    new NextRequest('http://localhost/api/teaching-model/help-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  );
}

describe('POST /api/teaching-model/help-turns', () => {
  let pool: RecordingPool;
  let ids = 0;

  const rowsFor = async (turnId: string) => {
    const result = await pool.query<{ id: string }>(`SELECT id FROM teaching_model_attempts WHERE turn_id = $1 ORDER BY attempt_index`, [turnId]);
    const rows: TeachingModelAttemptRow[] = [];
    for (const row of result.rows) rows.push((await readAttempt(pool, row.id))!);
    return rows;
  };

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://legacy-help-test');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    mocks.clientConstructed = 0;
    t = T0_MS;
    ids = 0;
    pool = await createTutorPool(mocks.events);
    mocks.events.length = 0;
    const { setLegacyHelpDepsForTests } = await import('@/app/api/teaching-model/help-turns/route');
    setLegacyHelpDepsForTests({
      queryable: pool as never,
      now,
      workerId: 'host:1:test',
      executor: { rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}` },
    });
  });

  afterEach(async () => {
    const { setLegacyHelpDepsForTests } = await import('@/app/api/teaching-model/help-turns/route');
    setLegacyHelpDepsForTests(undefined);
    expect(mocks.clientConstructed).toBe(0);
    await pool.end();
  });

  it('requires the service key and the configured API', async () => {
    expect((await post(body(), null)).status).toBe(401);
    expect((await post(body(), 'Bearer wrong')).status).toBe(401);
    vi.stubEnv('DATABASE_URL', '');
    expect((await post(body())).status).toBe(404);
  });

  it('validates: unrouted or null subject code → 422 SUBJECT_ROUTE_UNAVAILABLE; units > 10,000 chars → 422 GROUNDING_TOO_LARGE; > 40 history → 400; digest mismatch → 400', async () => {
    const unrouted = await post(body({ subject: { code: 'FRENCH', nameAr: 'فرنسي', nameEn: 'French', academicLanguage: 'en' } }));
    expect(unrouted.status).toBe(422);
    await expect(unrouted.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_ROUTE_UNAVAILABLE', retryable: false } });
    const nullCode = await post(body({ subject: { code: null, nameAr: null, nameEn: 'Physics', academicLanguage: 'ar' } }));
    expect(nullCode.status).toBe(422);
    await expect(nullCode.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_ROUTE_UNAVAILABLE' } });

    const big = await post(body({ grounding: { units: [{ unitId: 'u', title: null, text: 'ن'.repeat(10_001), charLength: 10_001 }], truncated: false } }));
    expect(big.status).toBe(422);
    await expect(big.json()).resolves.toMatchObject({ error: { code: 'GROUNDING_TOO_LARGE', details: { totalChars: 10_001, cap: 10_000 } } });

    const history = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'tutor' : 'student', text: `m${i}` }));
    expect((await post(body({ history }))).status).toBe(400);

    const tampered = { ...body(), message: { text: 'نص آخر' } };
    const mismatch = await post(tampered);
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('runs one help turn: started row before the call, completion before the response, origin kafuo_backend, budget on the captured messages', async () => {
    mocks.callLLM.mockImplementationOnce(async () => {
      mocks.events.push('model');
      return ok('مثال: دفع عربة كتلتها 2 كجم بتسارع 3 م/ث² يحتاج قوة 6 نيوتن.');
    });
    const response = await post(body());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      text: 'مثال: دفع عربة كتلتها 2 كجم بتسارع 3 م/ث² يحتاج قوة 6 نيوتن.',
      servedBy: 'primary',
      safety: { triggered: false, boundary: false },
      groundingMode: 'scene',
      attemptIds: ['tma-1'],
      accountingComplete: true,
      budget: { counterKind: 'proxy' },
    });
    expect(json.budget.estimate).toBeGreaterThan(0);
    expect(mocks.events).toEqual(['ledger:insert', 'model', 'ledger:update']);
    const [row] = await rowsFor('kafuo:conv:123:cm-abc');
    expect(row).toMatchObject({
      capability: 'help',
      stage: 'help-turn',
      origin: 'kafuo_backend',
      accounting_status: 'complete',
      outcome: 'succeeded',
      conversation_id: 'kafuo:123',
      turn_id: 'kafuo:conv:123:cm-abc',
      student_ref: STUDENT_REF,
      learning_item_type: 'lesson',
      learning_item_id: '77',
      legacy_help_link_ref: 'link:55',
      subject_code: 'PHYSICS',
      budget_counter_kind: 'exact',
    });
    // The exact provider request: Scene-scope instruction, the unit under its title, no ids, under every cap.
    const [params, stage, , thinking] = mocks.callLLM.mock.calls[0]!;
    expect(stage).toBe('help-turn');
    expect(thinking).toEqual({ mode: 'enabled', effort: 'low' });
    const texts = (params.messages as Array<{ role: string; content: string }>).map((m) => m.content);
    expect(texts[2]).toContain('Lesson Help anchored to the current Scene');
    expect(texts[2]).toContain('Scene / المشهد: قانون نيوتن الثاني');
    expect(texts[2]).toContain('### القوة والتسارع');
    expect(texts.join('\n')).not.toContain('u-1');
    expect(texts.join('\n')).not.toContain('link:55');
    expect(params.messages[params.messages.length - 1]).toEqual({ role: 'user', content: 'اشرح لي مثالاً بسيطاً' });
    expect(countTokens(params.messages, 'proxy', 'qwen:qwen3.7-flash')).toBeLessThanOrEqual(effectiveCap('proxy'));
    expect(countTokens(params.messages, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(effectiveCap('exact'));
    expect((await readLegacyHelpTurn(pool, 'kafuo:conv:123:cm-abc'))!).toMatchObject({ status: 'completed', servedBy: 'primary', groundingMode: 'scene' });
  });

  it('Primary 429 → Fallback with two origin=kafuo_backend ledger rows', async () => {
    mocks.callLLM.mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(ok('الجواب من المسار الاحتياطي.'));
    const response = await post(body());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ servedBy: 'fallback', attemptIds: ['tma-1', 'tma-2'] });
    const rows = await rowsFor('kafuo:conv:123:cm-abc');
    expect(rows.map((r) => [r.role, r.outcome, r.origin, r.fallback_triggered])).toEqual([
      ['primary', 'rate_limited', 'kafuo_backend', true],
      ['fallback', 'succeeded', 'kafuo_backend', false],
    ]);
  });

  it('replays the same turnId + digest from storage without a new attempt; a different digest is 409 TURN_DIGEST_CONFLICT', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('الأولى.'));
    const first = await (await post(body())).json();
    const replay = await post(body());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(first);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect((await rowsFor('kafuo:conv:123:cm-abc')).length).toBe(1);

    const conflict = await post(body({ message: { text: 'سؤال مختلف بنفس المعرف' } }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'TURN_DIGEST_CONFLICT', retryable: false } });
  });

  it('a generating replay answers 409 TURN_IN_PROGRESS with Retry-After; a stale one is taken over', async () => {
    const payload = body();
    await beginLegacyHelpTurn(pool, { turnId: 'kafuo:conv:123:cm-abc', tenantId: '1', studentRef: STUDENT_REF, originConversationRef: 'kafuo:123', requestDigest: payload.requestDigest as string, now: T0_MS / 1000 });
    t += 10_000;
    const busy = await post(payload);
    expect(busy.status).toBe(409);
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThanOrEqual(100);
    await expect(busy.json()).resolves.toMatchObject({ error: { code: 'TURN_IN_PROGRESS', retryable: true } });
    expect(mocks.callLLM).not.toHaveBeenCalled();

    t += 130_000;
    mocks.callLLM.mockResolvedValueOnce(ok('بعد الانتظار.'));
    const taken = await post(payload);
    expect(taken.status).toBe(200);
    await expect(taken.json()).resolves.toMatchObject({ text: 'بعد الانتظار.' });
  });

  it('guard on both routes: the directive reaches the fallback too; a violating reply is replaced by the boundary', async () => {
    mocks.callLLM
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(ok('Step 1: pour the gasoline into the jar.\nStep 2: light it with a match.'));
    const response = await post(body({ message: { text: 'ممكن أشعل البنزين في البيت عشان أشوف الاحتراق؟' } }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      text: SAFETY_BOUNDARY_MESSAGE,
      servedBy: 'fallback',
      safety: { triggered: true, category: 'fire_heating', boundary: true, code: 'SAFETY_BOUNDARY', reason: 'operational_sequence' },
    });
    for (const call of mocks.callLLM.mock.calls) {
      const messages = call[0].messages as Array<{ role: string; content: string }>;
      expect(messages[messages.length - 2]!.content).toContain('SAFETY DIRECTIVE');
    }
    // The ledger keeps the model's own outcome.
    expect((await rowsFor('kafuo:conv:123:cm-abc'))[1]!.outcome).toBe('succeeded');
  });

  it('empty grounding.units → groundingMode insufficient; help_card → stage help-card', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('لا أستطيع تأكيد ما يذكره الدرس.'));
    const response = await post(body({ turnId: 'op:abc', grounding: { units: [], truncated: false }, helpScope: { kind: 'help_card', label: 'بطاقة', cardKey: 'c1', stepNumber: 2, intent: 'hint' } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ groundingMode: 'insufficient' });
    const texts = (mocks.callLLM.mock.calls[0]![0].messages as Array<{ content: string }>).map((m) => m.content);
    expect(texts[2]).toContain('No curriculum text is available');
    expect(mocks.callLLM.mock.calls[0]![1]).toBe('help-card');
    expect((await rowsFor('op:abc'))[0]).toMatchObject({ stage: 'help-card', conversation_id: null });
  });

  it('help_card on a runner slide: the slide text grounds the card and the intent hint reaches the prompt; a missing slide falls back', async () => {
    const { setLegacyHelpDepsForTests } = await import('@/app/api/teaching-model/help-turns/route');
    const loadSlide = vi.fn(async (input: { tenantId: string; versionId: string; sceneId: string }) =>
      input.sceneId === 'scene-7'
        ? { sceneTitle: 'من الأمثلة إلى قاعدة التخمين', sceneText: 'نلاحظ النمط في الأمثلة ثم نخمّن القاعدة العامة.' }
        : null,
    );
    setLegacyHelpDepsForTests({
      queryable: pool as never,
      now,
      workerId: 'host:1:test',
      executor: { rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}` },
      loadSlide,
    });
    const scope = (sceneId: string) => ({
      kind: 'help_card',
      label: 'شريحة «من الأمثلة إلى قاعدة التخمين»',
      cardKey: sceneId,
      stepNumber: null,
      intent: 'give_hint',
      slide: { versionId: 'tpv-1', sceneId },
      intentHint: 'hint',
    });

    mocks.callLLM.mockResolvedValueOnce(ok('لاحظ ما يتكرر في كل مثال.'));
    const response = await post(body({ turnId: 'op:slide', grounding: { units: [], truncated: false }, helpScope: scope('scene-7') }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ groundingMode: 'scene' });
    expect(loadSlide).toHaveBeenCalledWith({ tenantId: '1', versionId: 'tpv-1', sceneId: 'scene-7' });
    const prompt = (mocks.callLLM.mock.calls[0]![0].messages as Array<{ content: string }>).map((m) => m.content).join('\n');
    expect(prompt).toContain('نلاحظ النمط في الأمثلة ثم نخمّن القاعدة العامة.');
    expect(prompt).toContain('من الأمثلة إلى قاعدة التخمين');
    expect(prompt).toContain('HINT ONLY');
    expect(prompt).not.toContain('No curriculum text is available');

    mocks.callLLM.mockResolvedValueOnce(ok('لا أستطيع تأكيد ما يذكره الدرس.'));
    const missing = await post(body({ turnId: 'op:slide-miss', grounding: { units: [], truncated: false }, helpScope: scope('scene-x') }));
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toMatchObject({ groundingMode: 'insufficient' });
  });

  it('rejects a malformed slide anchor or an unknown intent hint', async () => {
    const bad = (helpScope: Record<string, unknown>) =>
      post(body({ turnId: 'op:bad', helpScope: { kind: 'help_card', label: null, cardKey: null, stepNumber: null, intent: null, ...helpScope } }));
    expect((await bad({ slide: { versionId: '', sceneId: 's' } })).status).toBe(400);
    expect((await bad({ intentHint: 'reveal_answer' })).status).toBe(400);
  });

  it('both routes fail → 503 TEACHING_MODEL_UNAVAILABLE (retryable), the row is failed and a retry re-runs', async () => {
    mocks.callLLM.mockRejectedValueOnce(apiError(503)).mockRejectedValueOnce(apiError(502));
    const response = await post(body());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true } });
    expect((await readLegacyHelpTurn(pool, 'kafuo:conv:123:cm-abc'))!).toMatchObject({ status: 'failed', errorCode: 'TEACHING_MODEL_UNAVAILABLE', attemptIds: ['tma-1', 'tma-2'] });
    mocks.callLLM.mockResolvedValueOnce(ok('نجح الآن.'));
    const retry = await post(body());
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ text: 'نجح الآن.', attemptIds: ['tma-3'] });
  });
});
