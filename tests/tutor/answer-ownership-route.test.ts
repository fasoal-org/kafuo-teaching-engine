import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveConversation,
  insertConversation,
  insertHelpTutorMessage,
  insertStudentMessage,
  insertTutorMessage,
  upsertHelpSession,
} from '@/lib/persistence/tutor-runtime';
import {
  signWebhookDelivery,
  WEBHOOK_EVENT_HEADERS,
} from '@/lib/server/teaching-package/webhook-delivery';
import { FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE } from '@/lib/server/tutor/kafuo-request-signature';
import type { MeterRefusalCache } from '@/lib/server/tutor/meter-refusal-cache';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';

import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  OTHER_STUDENT_REF,
  RecordingPool,
  STUDENT_REF,
  studentBearer,
  T0_MS,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * POST /api/tutor/answers/ownership (D-05 plan §3.2 B, §4.1): the signed
 * Kafuo → TE question "is this a rateable Kafuo answer of this tenant +
 * student?". PGlite rows seeded through the persistence layer; the model,
 * Kafuo client and refusal cache are spies that must never be called.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  logs: [] as unknown[][],
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));

vi.mock('@/lib/logger', () => {
  const record =
    () =>
    (...args: unknown[]) => {
      mocks.logs.push(args);
    };
  return {
    createLogger: () => ({ info: record(), warn: record(), error: record(), debug: record() }),
  };
});

const SERVICE_KEY = 'answer-ownership-svc-key';
const SECRET = 'answer-ownership-webhook-secret';
const NOW_S = T0_MS / 1000;

const ANSWER = 'msg-answer-1';
const CLARIFICATION = 'msg-clarification-1';
const ARCHIVED_ANSWER = 'msg-archived-answer-1';
const BOUNDARY = 'msg-boundary-1';
const FAILED = 'msg-failed-1';
const GENERATING = 'msg-generating-1';
const STUDENT_MESSAGE = 'msg-student-1';
const OTHER_STUDENT_ANSWER = 'msg-other-student-1';
const OTHER_TENANT_ANSWER = 'msg-other-tenant-1';
const HELP_ANSWER = 'msg-help-answer-1';
const UNKNOWN = 'msg-0b9c8c5e-6c1b-4b5e-9a39-3f1f6a0c2d11';

async function route() {
  return import('@/app/api/tutor/answers/ownership/route');
}

function ownershipBody(
  overrides: { tenantId?: string; studentRef?: string; messageId?: unknown } = {},
): Record<string, unknown> {
  return {
    purpose: FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE,
    tenantContext: { tenantId: overrides.tenantId ?? '1' },
    studentRef: overrides.studentRef ?? STUDENT_REF,
    messageId: 'messageId' in overrides ? overrides.messageId : ANSWER,
  };
}

/**
 * The request Kafuo sends: the raw body is serialized ONCE, signed, and those
 * exact bytes are sent.
 */
function signedRequest(
  body: unknown,
  options: {
    auth?: string | null;
    raw?: string;
    timestamp?: string;
    secret?: string;
    signature?: string;
  } = {},
): NextRequest {
  const raw = options.raw ?? JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? signWebhookDelivery(options.secret ?? SECRET, timestamp, raw);
  const auth = options.auth === undefined ? `Bearer ${SERVICE_KEY}` : options.auth;
  return new NextRequest('http://localhost/api/tutor/answers/ownership', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
      [WEBHOOK_EVENT_HEADERS.timestamp]: timestamp,
      [WEBHOOK_EVENT_HEADERS.signature]: signature,
    },
    body: raw,
  });
}

async function ask(request: NextRequest) {
  const response = await (await route()).POST(request);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json, response };
}

describe('POST /api/tutor/answers/ownership', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let refusalCache: { get: ReturnType<typeof vi.fn>; remember: ReturnType<typeof vi.fn> };
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  async function seedConversation(input: {
    id: string;
    tenantId: string;
    studentRef: string;
  }): Promise<void> {
    await insertConversation(pool, {
      ...input,
      subjectCode: 'MATH',
      subjectOfferingId: '10',
      subjectName: 'الرياضيات',
      academic: {
        curriculumName: 'المنهج الوطني',
        curriculumVersionLabel: '2026',
        gradeLabel: 'الصف التاسع',
        academicLanguage: 'ar',
      },
      now: NOW_S,
    });
  }

  async function seedTutor(
    conversationId: string,
    id: string,
    seq: number,
    options: { safety?: Record<string, unknown>; groundingMode?: 'none' | 'clarification' } = {},
  ): Promise<void> {
    await insertTutorMessage(pool, {
      id,
      parentId: conversationId,
      seq,
      turnId: `turn-${id}`,
      turnAttempt: 1,
      text: `reply ${id}`,
      servedBy: options.safety ? null : 'primary',
      groundingMode: options.groundingMode ?? 'none',
      safety: options.safety ?? null,
      accountingComplete: true,
      now: NOW_S,
    });
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', 'postgres://answer-ownership-test');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.logs.length = 0;
    resetTurnRateLimitForTests();
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    pool = await createTutorPool();
    kafuo = fakeKafuo();
    refusalCache = { get: vi.fn(() => null), remember: vi.fn() };
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now: () => T0_MS,
      refusalCache: refusalCache as unknown as MeterRefusalCache,
    });

    // The student's active conversation: a question, answers of every kind.
    await seedConversation({ id: 'conv-mine', tenantId: '1', studentRef: STUDENT_REF });
    await insertStudentMessage(pool, {
      id: STUDENT_MESSAGE,
      parentId: 'conv-mine',
      seq: 1,
      clientMessageId: 'client-1',
      turnId: 'turn-1',
      text: 'ما هو التبرير الاستقرائي؟',
      now: NOW_S,
    });
    await seedTutor('conv-mine', ANSWER, 2);
    await seedTutor('conv-mine', CLARIFICATION, 3, { groundingMode: 'clarification' });
    await seedTutor('conv-mine', BOUNDARY, 4, {
      safety: {
        triggered: true,
        category: null,
        categories: [],
        boundary: true,
        code: 'SAFETY_BOUNDARY',
        reason: 'guard_error',
      },
    });
    // The turn path writes tutor rows `completed` only; the rule still refuses others.
    await seedTutor('conv-mine', FAILED, 5);
    await seedTutor('conv-mine', GENERATING, 6);
    await pool.query(`UPDATE tutor_messages SET status = 'failed' WHERE id = $1`, [FAILED]);
    await pool.query(`UPDATE tutor_messages SET status = 'generating' WHERE id = $1`, [GENERATING]);

    // An archived conversation of the same student.
    await seedConversation({ id: 'conv-archived', tenantId: '1', studentRef: STUDENT_REF });
    await seedTutor('conv-archived', ARCHIVED_ANSWER, 1);
    await archiveConversation(
      pool,
      'conv-archived',
      { tenantId: '1', studentRef: STUDENT_REF },
      NOW_S,
    );

    // Another student of the same tenant, and the same ref in another tenant.
    await seedConversation({
      id: 'conv-other-student',
      tenantId: '1',
      studentRef: OTHER_STUDENT_REF,
    });
    await seedTutor('conv-other-student', OTHER_STUDENT_ANSWER, 1);
    await seedConversation({ id: 'conv-other-tenant', tenantId: '2', studentRef: STUDENT_REF });
    await seedTutor('conv-other-tenant', OTHER_TENANT_ANSWER, 1);

    // A Help answer of the same student (tutor_help_messages).
    await pool.query(`INSERT INTO teaching_package_versions (id) VALUES ('tpv-1')`);
    await upsertHelpSession(pool, {
      id: 'help-1',
      tenantId: '1',
      versionId: 'tpv-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      learnerKey: 'learner-1',
      studentRef: STUDENT_REF,
      subjectCode: 'MATH',
      now: NOW_S,
    });
    await insertHelpTutorMessage(pool, {
      id: HELP_ANSWER,
      parentId: 'help-1',
      seq: 1,
      turnId: 'turn-help-1',
      turnAttempt: 1,
      text: 'help reply',
      servedBy: 'primary',
      groundingMode: 'scene',
      accountingComplete: true,
      now: NOW_S,
    });
  });

  afterEach(async () => {
    // No Kafuo meter / grounding call, no model call, no refusal-cache use — ever.
    expect(kafuo.reserve).not.toHaveBeenCalled();
    expect(kafuo.finalize).not.toHaveBeenCalled();
    expect(kafuo.groundingSearch).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(refusalCache.get).not.toHaveBeenCalled();
    expect(refusalCache.remember).not.toHaveBeenCalled();
    for (const spy of consoleSpies) spy.mockRestore();
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  it('answers a plain 404 when the Teaching Package API is off', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const offDb = await ask(signedRequest(ownershipBody()));
    expect(offDb.status).toBe(404);
    expect(offDb.json).toBeNull();
    vi.stubEnv('DATABASE_URL', 'postgres://answer-ownership-test');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect((await ask(signedRequest(ownershipBody()))).status).toBe(404);
  });

  it('requires the service key: 401 without it, with a wrong one, and with a student grant', async () => {
    for (const auth of [null, 'Bearer wrong-key', studentBearer()]) {
      const result = await ask(signedRequest(ownershipBody(), { auth }));
      expect(result.status).toBe(401);
      expect(result.json).toMatchObject({ error: { code: 'SERVICE_UNAUTHENTICATED' } });
    }
  });

  it('refuses a bad, tampered or wrong-secret signature (401 SIGNATURE_INVALID)', async () => {
    const raw = JSON.stringify(ownershipBody());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const cases = [
      signedRequest(null, { raw, signature: 'v1=deadbeef' }),
      signedRequest(null, { raw, signature: '' }),
      signedRequest(null, { raw, secret: SERVICE_KEY }),
      // Signed over one body, another sent.
      signedRequest(null, {
        raw: JSON.stringify(ownershipBody({ studentRef: OTHER_STUDENT_REF })),
        timestamp,
        signature: signWebhookDelivery(SECRET, timestamp, raw),
      }),
    ];
    for (const request of cases) {
      const result = await ask(request);
      expect(result.status).toBe(401);
      expect(result.json).toMatchObject({ error: { code: 'SIGNATURE_INVALID' } });
    }
  });

  it('refuses a stale, future or non-digit timestamp (400 SIGNATURE_STALE)', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    for (const timestamp of [String(nowS - 400), String(nowS + 400), 'yesterday']) {
      const result = await ask(signedRequest(ownershipBody(), { timestamp }));
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ error: { code: 'SIGNATURE_STALE' } });
    }
  });

  it('refuses a signed body without the ownership purpose, a replayed TE→Kafuo body included (401)', async () => {
    const withoutPurpose = ownershipBody();
    delete withoutPurpose.purpose;
    const webhookBody = {
      id: 'tpe-1',
      type: 'teaching_package.status_changed',
      tenantContext: { tenantId: '1' },
      data: {},
    };
    for (const body of [withoutPurpose, { ...ownershipBody(), purpose: 'other' }, webhookBody]) {
      const result = await ask(signedRequest(body));
      expect(result.status).toBe(401);
      expect(result.json).toMatchObject({ error: { code: 'SIGNATURE_INVALID' } });
    }
  });

  it('never passes with an empty TE secret (503 INTEGRATION_NOT_CONFIGURED)', async () => {
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', '');
    const result = await ask(signedRequest(ownershipBody(), { secret: '' }));
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({ error: { code: 'INTEGRATION_NOT_CONFIGURED' } });
  });

  it('refuses a bad body after a valid signature (400)', async () => {
    const tooLong = `msg-${'a'.repeat(61)}`;
    for (const messageId of [
      undefined,
      42,
      '',
      'msg-',
      'conv-mine',
      'msg-a b',
      'msg-a/b',
      tooLong,
    ]) {
      const result = await ask(signedRequest(ownershipBody({ messageId })));
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    const badRef = await ask(signedRequest(ownershipBody({ studentRef: 'short' })));
    expect(badRef.status).toBe(400);
    expect(badRef.json).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const noTenant = ownershipBody();
    delete noTenant.tenantContext;
    const missingTenant = await ask(signedRequest(noTenant));
    expect(missingTenant.status).toBe(400);
    expect(missingTenant.json).toMatchObject({ error: { code: 'TENANT_REQUIRED' } });

    const notJson = await ask(signedRequest(null, { raw: 'not json' }));
    expect(notJson.status).toBe(400);
    expect(notJson.json).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    // 64 characters is the longest id the shape accepts (it reads as unknown here).
    const longest = await ask(signedRequest(ownershipBody({ messageId: `msg-${'a'.repeat(60)}` })));
    expect(longest.status).toBe(404);
  });

  it('answers rateable for a completed answer, a clarification reply and an archived conversation', async () => {
    for (const messageId of [ANSWER, CLARIFICATION, ARCHIVED_ANSWER]) {
      const result = await ask(signedRequest(ownershipBody({ messageId })));
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ rateable: true });
      expect(result.response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers rateable:false with the reason for failed, generating and boundary answers', async () => {
    const expected: Array<[string, string]> = [
      [FAILED, 'not_completed'],
      [GENERATING, 'not_completed'],
      [BOUNDARY, 'safety_boundary'],
    ];
    for (const [messageId, reason] of expected) {
      const result = await ask(signedRequest(ownershipBody({ messageId })));
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ rateable: false, reason });
    }
  });

  it('answers one identical ANSWER_NOT_FOUND for every not-owned or unknown case', async () => {
    const cases = [
      ownershipBody({ messageId: OTHER_STUDENT_ANSWER }),
      ownershipBody({ messageId: OTHER_TENANT_ANSWER }),
      ownershipBody({ messageId: ANSWER, studentRef: OTHER_STUDENT_REF }),
      ownershipBody({ messageId: ANSWER, tenantId: '2' }),
      ownershipBody({ messageId: UNKNOWN }),
      ownershipBody({ messageId: STUDENT_MESSAGE }),
      ownershipBody({ messageId: HELP_ANSWER }),
    ];
    const texts = new Set<string>();
    for (const body of cases) {
      const result = await ask(signedRequest(body));
      expect(result.status).toBe(404);
      expect(result.json).toMatchObject({ error: { code: 'ANSWER_NOT_FOUND' } });
      texts.add(result.text);
    }
    expect(texts.size).toBe(1);
  });

  it('uses no turn bucket: more checks than TUTOR_TURNS_PER_MINUTE all answer', async () => {
    vi.stubEnv('TUTOR_TURNS_PER_MINUTE', '1');
    for (let i = 0; i < 3; i += 1) {
      expect((await ask(signedRequest(ownershipBody()))).status).toBe(200);
    }
  });

  it('logs nothing of the body: no text, ref or message id', async () => {
    await ask(signedRequest(ownershipBody()));
    await ask(signedRequest(ownershipBody({ messageId: OTHER_STUDENT_ANSWER })));
    await ask(signedRequest(ownershipBody({ messageId: BOUNDARY })));
    await ask(signedRequest(ownershipBody(), { signature: 'v1=00' }));
    const logged = JSON.stringify([mocks.logs, ...consoleSpies.map((spy) => spy.mock.calls)]);
    for (const secretish of [STUDENT_REF, ANSWER, OTHER_STUDENT_ANSWER, BOUNDARY, 'reply ']) {
      expect(logged).not.toContain(secretish);
    }
  });
});
