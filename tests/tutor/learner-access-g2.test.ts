/**
 * G2 (Wave 2 verifier, V2 item 1 — ET-16 c): learner grant re-validation.
 *
 * `lib/server/tutor/learner-access.ts`: Kafuo's `POST /learner-access/check`
 * answer per (tenant, studentRef, learning item), cached ≤ 5 min, failing closed;
 * the version → learning item read; the learner-only rule (edit / preview grants
 * are never checked); the unconfigured-integration rule (skipped in development,
 * fail closed in production); and the Help history read
 * (`GET /api/tutor/help/sessions`) refusing with the Help turn's envelope.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { AppScene } from '@/lib/types/stage';
import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import {
  KafuoIntegrationError,
  KafuoUnreachableError,
  type LearnerAccessCheckRequest,
  type LearnerAccessCheckResult,
} from '@/lib/server/tutor/kafuo-integration-client';
import {
  checkLearnerAccessScope,
  evaluateLearnerGrantAccess,
  learnerDeliveryError,
  learnerHelpError,
  resetLearnerAccessCacheForTests,
  type LearnerAccessScope,
} from '@/lib/server/tutor/learner-access';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';
import type { LearnerStudentContext } from '@/lib/server/tutor/student-context';

import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';
import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  RecordingPool,
  STUDENT_REF,
  T0_MS,
} from './tutor-test-harness';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const TENANT = '1';
const SCOPE: LearnerAccessScope = {
  tenantId: TENANT,
  studentRef: STUDENT_REF,
  learningItemId: 'li-7',
  learningItemType: 'lesson',
};

const STUDENT: LearnerStudentContext = {
  studentRef: STUDENT_REF,
  academic: { curriculumName: 'National', curriculumVersionLabel: '2026', gradeLabel: 'Grade 9' },
  subject: { code: 'CHEMISTRY', nameAr: 'الكيمياء', nameEn: 'Chemistry', academicLanguage: 'ar' },
  localeHint: 'ar',
  entitlements: { help: true },
};

function fakeClient(answer: LearnerAccessCheckResult | Error = { allowed: true }) {
  const state = { answer };
  const checkLearnerAccess = vi.fn(
    async (_request: LearnerAccessCheckRequest): Promise<LearnerAccessCheckResult> => {
      if (state.answer instanceof Error) throw state.answer;
      return state.answer;
    },
  );
  return { client: { checkLearnerAccess }, checkLearnerAccess, state };
}

let t = T0_MS;
const now = () => t;

/** A Stage document plus an approved version over it (the version FK needs the Stage). */
async function seedVersion(
  pool: RecordingPool,
  input: { id: string; stageId: string; item: { type: 'lesson' | 'section'; id: string } },
) {
  await createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as never,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  }).saveDocument(
    makeDocument(input.stageId, 'Lesson', [makeSlideScene('sc-1', input.stageId, 1)]),
  );
  await insertVersion(pool as never, {
    id: input.id,
    aggregate: { tenantId: TENANT, learningItem: input.item },
    version: 1,
    status: 'approved',
    currentStageId: input.stageId,
    teachingModel: { key: 'g5', version: 'g5.v1' },
    now: 1,
  });
}
const configured = { configured: true, production: true, now };

beforeEach(() => {
  vi.unstubAllEnvs();
  resetLearnerAccessCacheForTests();
  t = T0_MS;
});

describe('checkLearnerAccessScope', () => {
  it('asks Kafuo once per scope inside the cache window, again after it', async () => {
    const fake = fakeClient();
    const deps = { ...configured, client: fake.client };
    expect(await checkLearnerAccessScope(SCOPE, deps)).toEqual({ kind: 'allowed', scope: SCOPE });
    t += 59_000;
    await checkLearnerAccessScope(SCOPE, deps);
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(1);
    expect(fake.checkLearnerAccess).toHaveBeenCalledWith({
      tenantId: TENANT,
      studentRef: STUDENT_REF,
      learningItemId: 'li-7',
      learningItemType: 'lesson',
    });
    t += 2_000; // past the default 60 s
    await checkLearnerAccessScope(SCOPE, deps);
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(2);
  });

  it('caches per student and item: another item or student is asked separately', async () => {
    const fake = fakeClient();
    const deps = { ...configured, client: fake.client };
    await checkLearnerAccessScope(SCOPE, deps);
    await checkLearnerAccessScope({ ...SCOPE, learningItemId: 'li-8' }, deps);
    await checkLearnerAccessScope({ ...SCOPE, studentRef: 'zyxwvutsrqponmlkjihgfedc' }, deps);
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(3);
  });

  it('caches a refusal too, and never longer than five minutes', async () => {
    vi.stubEnv('LEARNER_ACCESS_CACHE_SECONDS', '3600');
    const fake = fakeClient({ allowed: false, reason: 'paid_ended_lesson_locked' });
    const deps = { ...configured, client: fake.client };
    expect(await checkLearnerAccessScope(SCOPE, deps)).toEqual({
      kind: 'denied',
      reason: 'paid_ended_lesson_locked',
    });
    t += 299_000;
    await checkLearnerAccessScope(SCOPE, deps);
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(1);
    t += 2_000; // 301 s: the 300 s cap applies whatever the env says
    fake.state.answer = { allowed: true };
    expect((await checkLearnerAccessScope(SCOPE, deps)).kind).toBe('allowed');
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(2);
  });

  it('LEARNER_ACCESS_CACHE_SECONDS=0 asks every time', async () => {
    vi.stubEnv('LEARNER_ACCESS_CACHE_SECONDS', '0');
    const fake = fakeClient();
    const deps = { ...configured, client: fake.client };
    await checkLearnerAccessScope(SCOPE, deps);
    await checkLearnerAccessScope(SCOPE, deps);
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(2);
  });

  it('fails closed, uncached, when Kafuo is unreachable or answers temporarily_unavailable', async () => {
    const fake = fakeClient(new KafuoUnreachableError('down', { status: 502 }));
    const deps = { ...configured, client: fake.client };
    expect(await checkLearnerAccessScope(SCOPE, deps)).toEqual({
      kind: 'unavailable',
      reason: 'unreachable',
    });
    fake.state.answer = { allowed: false, reason: 'temporarily_unavailable' };
    expect(await checkLearnerAccessScope(SCOPE, deps)).toEqual({
      kind: 'unavailable',
      reason: 'temporarily_unavailable',
    });
    fake.state.answer = new KafuoIntegrationError('bad', 400, 'invalid_body');
    expect((await checkLearnerAccessScope(SCOPE, deps)).kind).toBe('unavailable');
    fake.state.answer = { allowed: true };
    expect((await checkLearnerAccessScope(SCOPE, deps)).kind).toBe('allowed');
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(4);
  });

  it('an unknown studentRef is a refusal', async () => {
    const fake = fakeClient(new KafuoIntegrationError('unknown', 404, 'student_ref_unknown'));
    expect(await checkLearnerAccessScope(SCOPE, { ...configured, client: fake.client })).toEqual({
      kind: 'denied',
      reason: 'student_ref_unknown',
    });
  });

  it('without the integration: skipped in development, fail closed in production', async () => {
    const fake = fakeClient({ allowed: false, reason: 'lesson_on_hold' });
    expect(
      await checkLearnerAccessScope(SCOPE, { client: fake.client, configured: false, production: false }),
    ).toEqual({ kind: 'allowed', scope: SCOPE });
    expect(
      await checkLearnerAccessScope(SCOPE, { client: fake.client, configured: false, production: true }),
    ).toEqual({ kind: 'unavailable', reason: 'not_configured' });
    expect(fake.checkLearnerAccess).not.toHaveBeenCalled();
  });
});

describe('evaluateLearnerGrantAccess', () => {
  let pool: RecordingPool;

  beforeEach(async () => {
    pool = await createTutorPool([], { packageSchema: true });
    await seedVersion(pool, { id: 'tpv-1', stageId: 'stage-1', item: { type: 'section', id: 'li-901' } });
  });

  afterEach(async () => {
    await pool.end();
  });

  const grant = (purpose: 'learner' | 'preview' | 'edit', student: LearnerStudentContext | null = STUDENT) => ({
    tenantId: TENANT,
    versionId: 'tpv-1',
    purpose,
    ...(student ? { student } : {}),
  });

  it('checks a learner grant against its version learning item', async () => {
    const fake = fakeClient();
    const outcome = await evaluateLearnerGrantAccess(grant('learner'), {
      ...configured,
      pool: pool as never,
      client: fake.client,
    });
    expect(outcome).toEqual({
      kind: 'allowed',
      scope: {
        tenantId: TENANT,
        studentRef: STUDENT_REF,
        learningItemId: 'li-901',
        learningItemType: 'section',
      },
    });
    expect(fake.checkLearnerAccess).toHaveBeenCalledTimes(1);
  });

  it('never checks edit or preview grants', async () => {
    const fake = fakeClient({ allowed: false, reason: 'lesson_on_hold' });
    for (const purpose of ['edit', 'preview'] as const) {
      expect(
        await evaluateLearnerGrantAccess(grant(purpose), {
          ...configured,
          pool: pool as never,
          client: fake.client,
        }),
      ).toEqual({ kind: 'allowed', scope: null });
    }
    expect(fake.checkLearnerAccess).not.toHaveBeenCalled();
  });

  it('serves a learner grant without the student block unchecked (every SECTION Stage today)', async () => {
    const fake = fakeClient({ allowed: false, reason: 'lesson_on_hold' });
    for (const deps of [configured, { configured: false, production: false, now }]) {
      expect(
        await evaluateLearnerGrantAccess(grant('learner', null), {
          ...deps,
          pool: pool as never,
          client: fake.client,
        }),
      ).toEqual({ kind: 'allowed', scope: null });
    }
    expect(fake.checkLearnerAccess).not.toHaveBeenCalled();
  });

  it('refuses a learner grant whose version is gone; a version read failure fails closed', async () => {
    const fake = fakeClient();
    expect(
      await evaluateLearnerGrantAccess(
        { ...grant('learner'), versionId: 'tpv-missing' },
        { ...configured, pool: pool as never, client: fake.client },
      ),
    ).toEqual({ kind: 'denied', reason: 'learning_item_unresolved' });
    const broken = { query: async () => Promise.reject(new Error('db down')) };
    expect(
      await evaluateLearnerGrantAccess(
        { ...grant('learner'), versionId: 'tpv-other' },
        { ...configured, pool: broken as never, client: fake.client },
      ),
    ).toEqual({ kind: 'unavailable', reason: 'unreachable' });
  });
});

describe('refusal envelopes', () => {
  it('delivery: LEARNER_ACCESS_REVOKED / ACCOUNT_INACTIVE (403), LEARNER_ACCESS_UNAVAILABLE (503)', () => {
    expect(learnerDeliveryError({ kind: 'allowed', scope: null })).toBeNull();
    expect(learnerDeliveryError({ kind: 'denied', reason: 'lesson_on_hold' })).toMatchObject({
      code: 'LEARNER_ACCESS_REVOKED',
      status: 403,
      details: { reason: 'lesson_on_hold' },
    });
    expect(learnerDeliveryError({ kind: 'denied', reason: 'account_inactive' })).toMatchObject({
      code: 'ACCOUNT_INACTIVE',
      status: 403,
    });
    expect(learnerDeliveryError({ kind: 'unavailable', reason: 'unreachable' })).toMatchObject({
      code: 'LEARNER_ACCESS_UNAVAILABLE',
      status: 503,
      details: { retryAfterS: 5 },
    });
    expect(learnerDeliveryError({ kind: 'unavailable', reason: 'not_configured' })).toMatchObject({
      code: 'INTEGRATION_NOT_CONFIGURED',
      status: 503,
    });
  });

  it('Help: the turn envelope (ALLOWANCE_EXHAUSTED + reason, ACCOUNT_INACTIVE, METER_UNAVAILABLE)', () => {
    expect(learnerHelpError({ kind: 'denied', reason: 'paid_ended_lesson_locked' })).toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
      status: 429,
      details: { reason: 'paid_ended_lesson_locked', window: null, resetAt: null },
    });
    expect(learnerHelpError({ kind: 'denied', reason: 'account_inactive' })).toMatchObject({
      code: 'ACCOUNT_INACTIVE',
    });
    expect(learnerHelpError({ kind: 'unavailable', reason: 'unreachable' })).toMatchObject({
      code: 'METER_UNAVAILABLE',
      status: 503,
    });
  });
});

describe('GET /api/tutor/help/sessions re-validates the learner grant', () => {
  let pool: RecordingPool;
  let check: ReturnType<typeof fakeClient>;

  beforeEach(async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'learner-access-g2-svc');
    vi.stubEnv('DATABASE_URL', 'postgres://learner-access-g2');
    vi.stubEnv('KAFUO_INTEGRATION_BASE_URL', 'https://kafuo.test/api/v2/integrations/teaching-engine');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec-g2');
    pool = await createTutorPool([], { packageSchema: true });
    await seedVersion(pool, {
      id: 'tpv-help',
      stageId: 'stage-help',
      item: { type: 'lesson', id: 'li-help' },
    });
    const kafuo = fakeKafuo();
    check = fakeClient();
    (kafuo.client as unknown as { checkLearnerAccess: unknown }).checkLearnerAccess =
      check.checkLearnerAccess;
    setTutorRuntimeDepsForTests({ pool: asConnectable(pool), kafuo: kafuo.client, now });
  });

  afterEach(async () => {
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  function cookie(purpose: 'learner' | 'preview' = 'learner') {
    const { token } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId: 'tpv-help',
      stageId: 'stage-help',
      capability: 'read',
      purpose,
      learnerRef: 'learner-ref-0123456789abcdef',
      student: STUDENT,
    });
    return `teaching_package_grant=${encodeURIComponent(JSON.stringify([token]))}`;
  }

  async function sessions(cookieHeader: string) {
    const { GET } = await import('@/app/api/tutor/help/sessions/route');
    const search = new URLSearchParams({
      versionId: 'tpv-help',
      stageId: 'stage-help',
      sceneId: 'sc-1',
    }).toString();
    return GET(
      new NextRequest(`http://localhost/api/tutor/help/sessions?${search}`, {
        headers: { cookie: cookieHeader },
      }),
    );
  }

  it('serves the history while Kafuo allows it', async () => {
    const response = await sessions(cookie());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: null, messages: [], hasMore: false });
    expect(check.checkLearnerAccess).toHaveBeenCalledWith({
      tenantId: TENANT,
      studentRef: STUDENT_REF,
      learningItemId: 'li-help',
      learningItemType: 'lesson',
    });
  });

  it('refuses it once access is gone, with the Help turn envelope', async () => {
    check.state.answer = { allowed: false, reason: 'paid_ended_lesson_locked' };
    const response = await sessions(cookie());
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'ALLOWANCE_EXHAUSTED',
        retryable: false,
        details: { reason: 'paid_ended_lesson_locked' },
      },
    });
  });

  it('fails closed (retryable 503 + Retry-After) when Kafuo cannot answer', async () => {
    check.state.answer = new KafuoUnreachableError('down');
    const response = await sessions(cookie());
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'METER_UNAVAILABLE', retryable: true },
    });
  });
});
