import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  KafuoIntegrationClient,
  KafuoIntegrationError,
  KafuoUnreachableError,
  type BankQuizScope,
} from '@/lib/server/tutor/kafuo-integration-client';
import {
  gradeBankQuiz,
  parseBankQuizAnswers,
  readBankQuizQuestions,
  type BankQuizDeps,
} from '@/lib/server/teaching-package/bank-quiz-service';
import type { VerifiedEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { AppScene } from '@/lib/types/stage';

/**
 * W6 one question source (contract item 3): the TE → Kafuo bank quiz calls are
 * signed like every integration call, carry only the grant's scope, and never
 * pass an answer key, model answer or rubric through to the classroom.
 */

const BASE = 'https://kafuo.test/api/v2/integrations/teaching-engine';
const SECRET = 'whsec-bank-quiz-test';
const NOW_MS = 1_800_000_000_123;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(answer: () => Response | Error) {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const result = answer();
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  const client = new KafuoIntegrationClient({
    baseUrl: BASE,
    secret: SECRET,
    fetchImpl,
    now: () => NOW_MS,
  });
  return { client, captured };
}

const SCOPE: BankQuizScope = {
  tenantId: '7',
  learningItemId: '306',
  versionId: 'tpv-AAAAAAAAAAAA',
  sceneId: 'scene-check',
  studentRef: 'ref-abcdefghijklmnop',
};

describe('quizQuestions (W6 contract item 3)', () => {
  it('signs "<ts>.<body>" and posts the scope to /quiz-questions', async () => {
    const kafuo = stub(() => json(200, { status: 'pending_approval', questions: [] }));
    const result = await kafuo.client.quizQuestions(SCOPE);
    expect(result).toEqual({ status: 'pending_approval', questions: [] });
    const [call] = kafuo.captured;
    expect(call!.url).toBe(`${BASE}/quiz-questions`);
    const headers = call!.init.headers as Record<string, string>;
    const timestamp = String(Math.floor(NOW_MS / 1000));
    expect(headers['X-Teaching-Engine-Timestamp']).toBe(timestamp);
    const expected = createHmac('sha256', SECRET)
      .update(`${timestamp}.${call!.init.body as string}`)
      .digest('hex');
    expect(headers['X-Teaching-Engine-Signature']).toBe(`v1=${expected}`);
    expect(JSON.parse(call!.init.body as string)).toEqual(SCOPE);
  });

  it('omits studentRef for an admin preview', async () => {
    const kafuo = stub(() => json(200, { status: 'not_bank', questions: [] }));
    const { studentRef: _omitted, ...preview } = SCOPE;
    await kafuo.client.quizQuestions(preview);
    expect(JSON.parse(kafuo.captured[0]!.init.body as string)).not.toHaveProperty('studentRef');
  });

  it('projects questions through an allowlist: no key, model answer or rubric passes', async () => {
    const kafuo = stub(() =>
      json(200, {
        status: 'ready',
        questions: [
          {
            id: 'bank:41',
            question_type: 'multiple_answer',
            text: 'Pick the even numbers',
            choices: [
              { id: 'A', text: '2', is_correct: true },
              { id: 'B', text: '3' },
            ],
            correct_choice_ids: ['A'],
            correct_answer_json: { choice_ids: ['A'] },
            model_answer: 'two',
            grading_rubric: 'secret rubric',
            assets: [
              { url: 'https://cdn.test/a.png', alt: 'fig', secret: 'x' },
              { url: 'javascript:1' },
            ],
            points: 2,
          },
          { id: 'q_te_1', question_type: 'single_choice', text: 'not a bank id', choices: [] },
          { id: 'bank:42', question_type: 'essay', text: 'unknown type', choices: [] },
        ],
      }),
    );
    const result = await kafuo.client.quizQuestions(SCOPE);
    expect(result).toEqual({
      status: 'ready',
      questions: [
        {
          id: 'bank:41',
          questionType: 'multiple_answer',
          text: 'Pick the even numbers',
          choices: [
            { id: 'A', text: '2' },
            { id: 'B', text: '3' },
          ],
          assets: [{ url: 'https://cdn.test/a.png', alt: 'fig' }],
          points: 2,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/correct|model_answer|rubric|secret/);
  });

  it('reads an unknown status as not_bank and maps failures', async () => {
    expect(
      await stub(() => json(200, { status: 'weird', questions: [] })).client.quizQuestions(SCOPE),
    ).toEqual({ status: 'not_bank', questions: [] });
    await expect(
      stub(() => json(404, { error: { code: 'scene_not_found' } })).client.quizQuestions(SCOPE),
    ).rejects.toMatchObject({
      name: 'KafuoIntegrationError',
      status: 404,
      code: 'scene_not_found',
    });
    await expect(stub(() => json(503, {})).client.quizQuestions(SCOPE)).rejects.toBeInstanceOf(
      KafuoUnreachableError,
    );
  });
});

describe('quizGrades (W6 contract items 2–3)', () => {
  it('posts the scope plus answers and parses the snake_case grade body', async () => {
    const kafuo = stub(() =>
      json(200, {
        teaching_package_version_id: SCOPE.versionId,
        scene_id: SCOPE.sceneId,
        results: [
          {
            question_id: 'bank:41',
            status: 'correct',
            earned: 2,
            possible: 2,
            correct_answer: ['A'],
            explanation: 'Because.',
          },
        ],
        earned: 2,
        possible: 2,
        pending_possible: 0,
      }),
    );
    const answers = { 'bank:41': ['A'], 'bank:43': 'some text' };
    const result = await kafuo.client.quizGrades(SCOPE, answers);
    expect(kafuo.captured[0]!.url).toBe(`${BASE}/quiz-grades`);
    expect(JSON.parse(kafuo.captured[0]!.init.body as string)).toEqual({ ...SCOPE, answers });
    expect(result).toEqual({
      results: [
        {
          questionId: 'bank:41',
          status: 'correct',
          earned: 2,
          possible: 2,
          correctAnswer: ['A'],
          explanation: 'Because.',
        },
      ],
      earned: 2,
      possible: 2,
      pendingPossible: 0,
    });
  });

  it('a 503 grading_unavailable is a retryable unreachable error', async () => {
    const kafuo = stub(() => json(503, { error: { code: 'teaching_answer_grading_unavailable' } }));
    await expect(kafuo.client.quizGrades(SCOPE, { 'bank:1': 'A' })).rejects.toBeInstanceOf(
      KafuoUnreachableError,
    );
  });
});

// ---------------------------------------------------------------------------
// The service behind the TE route: the scope comes from the grant only.

const bankScene = {
  id: 'scene-check',
  type: 'quiz',
  questionSource: 'bank',
} as unknown as AppScene;
const ownScene = { id: 'scene-own', type: 'quiz' } as unknown as AppScene;

function grantOf(extra: Partial<VerifiedEditorGrant> = {}): VerifiedEditorGrant {
  return {
    tenantId: '7',
    versionId: 'tpv-AAAAAAAAAAAA',
    stageId: 'stage-1',
    capability: 'read',
    learnerKey: 'lk',
    exp: 0,
    ...extra,
  };
}

function deps(overrides: Partial<BankQuizDeps> = {}) {
  const client = {
    quizQuestions: vi.fn(async (_scope: BankQuizScope) => ({
      status: 'ready' as const,
      questions: [],
    })),
    quizGrades: vi.fn(async () => ({ results: [], earned: 0, possible: 0, pendingPossible: 0 })),
  };
  const value: BankQuizDeps = {
    learningItemIdOf: async () => '306',
    readScene: async (_stage, sceneId) =>
      sceneId === bankScene.id ? bankScene : sceneId === ownScene.id ? ownScene : null,
    checkLearnerAccess: vi.fn(async () => null),
    client,
    ...overrides,
  };
  return { value, client };
}

const STUDENT = {
  studentRef: 'ref-abcdefghijklmnop',
  academic: {},
  subject: {},
  entitlements: { help: true },
} as unknown as VerifiedEditorGrant['student'];

describe('bank quiz service', () => {
  it('a learner grant sends its studentRef after the access re-check', async () => {
    const { value, client } = deps();
    await readBankQuizQuestions(
      grantOf({ purpose: 'learner', student: STUDENT }),
      'scene-check',
      value,
    );
    expect(value.checkLearnerAccess).toHaveBeenCalledTimes(1);
    expect(client.quizQuestions).toHaveBeenCalledWith({
      tenantId: '7',
      learningItemId: '306',
      versionId: 'tpv-AAAAAAAAAAAA',
      sceneId: 'scene-check',
      studentRef: 'ref-abcdefghijklmnop',
    });
  });

  it('a preview grant sends no studentRef and skips the learner check', async () => {
    const { value, client } = deps();
    await readBankQuizQuestions(grantOf({ purpose: 'preview' }), 'scene-check', value);
    expect(value.checkLearnerAccess).not.toHaveBeenCalled();
    const scope = client.quizQuestions.mock.calls[0]![0];
    expect(scope).not.toHaveProperty('studentRef');
  });

  it('a revoked learner is refused before Kafuo is asked', async () => {
    const refusal = new TeachingPackageError('LEARNER_ACCESS_REVOKED', 'no');
    const { value, client } = deps({ checkLearnerAccess: async () => refusal });
    await expect(
      readBankQuizQuestions(
        grantOf({ purpose: 'learner', student: STUDENT }),
        'scene-check',
        value,
      ),
    ).rejects.toBe(refusal);
    expect(client.quizQuestions).not.toHaveBeenCalled();
  });

  it('a quiz without the marker answers not_bank without calling Kafuo; an unknown scene is 404', async () => {
    const { value, client } = deps();
    expect(await readBankQuizQuestions(grantOf(), 'scene-own', value)).toEqual({
      status: 'not_bank',
      questions: [],
    });
    expect(client.quizQuestions).not.toHaveBeenCalled();
    await expect(readBankQuizQuestions(grantOf(), 'nope', value)).rejects.toMatchObject({
      code: 'SCENE_NOT_FOUND',
    });
  });

  it('maps Kafuo failures to BANK_QUIZ_UNAVAILABLE / BANK_QUIZ_REFUSED', async () => {
    const down = deps({
      client: {
        quizQuestions: async () => {
          throw new KafuoUnreachableError('down', { status: 503 });
        },
        quizGrades: async () => {
          throw new KafuoIntegrationError('no', 422, 'invalid');
        },
      },
    });
    await expect(readBankQuizQuestions(grantOf(), 'scene-check', down.value)).rejects.toMatchObject(
      {
        code: 'BANK_QUIZ_UNAVAILABLE',
        status: 503,
      },
    );
    await expect(
      gradeBankQuiz(grantOf(), 'scene-check', { 'bank:1': 'A' }, down.value),
    ).rejects.toMatchObject({ code: 'BANK_QUIZ_REFUSED' });
  });

  it('accepts only bounded bank: answers', () => {
    expect(parseBankQuizAnswers({ 'bank:1': 'A', 'bank:2': ['A', 'C'], 'bank:3': 'text' })).toEqual(
      {
        'bank:1': 'A',
        'bank:2': ['A', 'C'],
        'bank:3': 'text',
      },
    );
    for (const bad of [
      null,
      [],
      {},
      { q_1: 'A' },
      { 'bank:1': 3 },
      { 'bank:1': 'x'.repeat(2001) },
    ]) {
      expect(() => parseBankQuizAnswers(bad)).toThrow(TeachingPackageError);
    }
  });
});
