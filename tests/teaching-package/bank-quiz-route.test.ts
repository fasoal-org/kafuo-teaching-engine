import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '@/lib/i18n/locales/en-US.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import { bankAnswersPayload, isBankAnswerComplete, type BankQuestion } from '@/lib/quiz/bank-quiz';

/**
 * W6 one question source: `GET|POST /api/stages/:id/bank-quiz`. The grant is
 * the only scope; the body's tenant / student fields are ignored; the browser
 * never sees a key.
 */

const mocks = vi.hoisted(() => ({
  resolveRegenerationGrant: vi.fn(),
  readVersionById: vi.fn(),
  readLiveScene: vi.fn(),
  evaluateLearnerGrantAccess: vi.fn(),
  quizQuestions: vi.fn(),
  quizGrades: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/regeneration-grant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/regeneration-grant')>()),
  resolveRegenerationGrant: mocks.resolveRegenerationGrant,
}));
vi.mock('@/lib/persistence/teaching-package', () => ({ readVersionById: mocks.readVersionById }));
vi.mock('@/lib/server/teaching-package/scene-regeneration-store', () => ({
  readLiveScene: mocks.readLiveScene,
}));
vi.mock('@/lib/server/tutor/learner-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/tutor/learner-access')>()),
  evaluateLearnerGrantAccess: mocks.evaluateLearnerGrantAccess,
}));
vi.mock('@/lib/server/tutor/kafuo-integration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/tutor/kafuo-integration-client')>()),
  getKafuoIntegrationClient: () => ({
    quizQuestions: mocks.quizQuestions,
    quizGrades: mocks.quizGrades,
  }),
}));

const STAGE = 'stage-1';
const params = { params: Promise.resolve({ id: STAGE }) };

function learnerGrant() {
  return {
    tenantId: '7',
    versionId: 'tpv-AAAAAAAAAAAA',
    stageId: STAGE,
    capability: 'read',
    learnerKey: 'lk',
    exp: 0,
    purpose: 'learner',
    student: {
      studentRef: 'ref-abcdefghijklmnop',
      academic: {},
      subject: {},
      entitlements: { help: true },
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolveRegenerationGrant.mockResolvedValue({
    ok: true,
    value: { grant: learnerGrant(), pool: {} },
  });
  mocks.readVersionById.mockResolvedValue({ tenantId: '7', learningItem: { id: '306' } });
  mocks.readLiveScene.mockResolvedValue({
    scene: { id: 'scene-check', type: 'quiz', questionSource: 'bank' },
    rev: 1,
  });
  mocks.evaluateLearnerGrantAccess.mockResolvedValue({ kind: 'allowed', scope: null });
});

describe('bank quiz route', () => {
  it('GET reads with the grant scope and returns the projection', async () => {
    mocks.quizQuestions.mockResolvedValue({ status: 'pending_approval', questions: [] });
    const { GET } = await import('@/app/api/stages/[id]/bank-quiz/route');
    const response = await GET(
      new NextRequest(`http://te.test/api/stages/${STAGE}/bank-quiz?sceneId=scene-check`),
      params,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ status: 'pending_approval', questions: [] });
    expect(mocks.quizQuestions).toHaveBeenCalledWith({
      tenantId: '7',
      learningItemId: '306',
      versionId: 'tpv-AAAAAAAAAAAA',
      sceneId: 'scene-check',
      studentRef: 'ref-abcdefghijklmnop',
    });
  });

  it('GET without a sceneId is 400', async () => {
    const { GET } = await import('@/app/api/stages/[id]/bank-quiz/route');
    const response = await GET(
      new NextRequest(`http://te.test/api/stages/${STAGE}/bank-quiz`),
      params,
    );
    expect(response.status).toBe(400);
  });

  it('GET with no grant answers the resolver’s 404', async () => {
    mocks.resolveRegenerationGrant.mockResolvedValue({
      ok: false,
      response: new Response('Not found', { status: 404 }),
    });
    const { GET } = await import('@/app/api/stages/[id]/bank-quiz/route');
    const response = await GET(
      new NextRequest(`http://te.test/api/stages/${STAGE}/bank-quiz?sceneId=scene-check`),
      params,
    );
    expect(response.status).toBe(404);
    expect(mocks.quizQuestions).not.toHaveBeenCalled();
  });

  it('POST grades; body tenant/student fields never reach Kafuo', async () => {
    mocks.quizGrades.mockResolvedValue({ results: [], earned: 0, possible: 1, pendingPossible: 0 });
    const { POST } = await import('@/app/api/stages/[id]/bank-quiz/route');
    const response = await POST(
      new NextRequest(`http://te.test/api/stages/${STAGE}/bank-quiz`, {
        method: 'POST',
        body: JSON.stringify({
          sceneId: 'scene-check',
          answers: { 'bank:1': 'A' },
          tenantId: '999',
          studentRef: 'forged',
        }),
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.quizGrades).toHaveBeenCalledWith(
      {
        tenantId: '7',
        learningItemId: '306',
        versionId: 'tpv-AAAAAAAAAAAA',
        sceneId: 'scene-check',
        studentRef: 'ref-abcdefghijklmnop',
      },
      { 'bank:1': 'A' },
    );
  });

  it('POST for a revoked learner is refused before Kafuo grades', async () => {
    mocks.evaluateLearnerGrantAccess.mockResolvedValue({
      kind: 'denied',
      reason: 'lesson_not_acquired',
    });
    const { POST } = await import('@/app/api/stages/[id]/bank-quiz/route');
    const response = await POST(
      new NextRequest(`http://te.test/api/stages/${STAGE}/bank-quiz`, {
        method: 'POST',
        body: JSON.stringify({ sceneId: 'scene-check', answers: { 'bank:1': 'A' } }),
      }),
      params,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'LEARNER_ACCESS_REVOKED' },
    });
    expect(mocks.quizGrades).not.toHaveBeenCalled();
  });
});

describe('bank quiz browser helpers', () => {
  const question = (questionType: BankQuestion['questionType']): BankQuestion => ({
    id: `bank:${questionType}`,
    questionType,
    text: 'Q',
    choices: [],
    assets: [],
    points: 1,
  });

  it('a multiple answer needs a non-empty list; the others a non-blank string', () => {
    expect(isBankAnswerComplete(question('multiple_answer'), ['A'])).toBe(true);
    expect(isBankAnswerComplete(question('multiple_answer'), [])).toBe(false);
    expect(isBankAnswerComplete(question('single_choice'), 'A')).toBe(true);
    expect(isBankAnswerComplete(question('short_answer'), '   ')).toBe(false);
    expect(isBankAnswerComplete(question('true_false'), undefined)).toBe(false);
  });

  it('sends only answered questions in the per-type shape', () => {
    const questions = [
      question('single_choice'),
      question('multiple_answer'),
      question('short_answer'),
    ];
    expect(
      bankAnswersPayload(questions, {
        'bank:single_choice': 'B',
        'bank:multiple_answer': [],
        'bank:short_answer': '  forty two ',
      }),
    ).toEqual({ 'bank:single_choice': 'B', 'bank:short_answer': 'forty two' });
  });
});

describe('bank quiz locale keys', () => {
  const keys = [
    'bankPending',
    'bankUnavailable',
    'gradingUnavailable',
    'trueFalse',
    'questionOf',
    'next',
    'previous',
  ];
  const locales = { enUS, arSA, deDE, esMX, frFR, jaJP, koKR, ptBR, ruRU, viVN, zhCN, zhTW };

  it.each(Object.entries(locales))('%s has every bank quiz key', (_code, locale) => {
    const quiz = (locale as { quiz: Record<string, unknown> }).quiz;
    for (const key of keys) {
      expect(typeof quiz[key], key).toBe('string');
      expect((quiz[key] as string).length, key).toBeGreaterThan(0);
    }
    expect(quiz.questionOf).toContain('{{current}}');
    expect(quiz.questionOf).toContain('{{total}}');
  });
});
