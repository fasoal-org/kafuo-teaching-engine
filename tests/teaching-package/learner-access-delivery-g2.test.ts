/**
 * G2 (Wave 2 verifier, V2 item 1 — ET-16 c): learner delivery is re-validated.
 *
 * - `GET /api/persistence/documents/<stage>` under a LEARNER grant asks Kafuo
 *   (`learner-access.ts`) before serving: a revoked learner gets 403
 *   `LEARNER_ACCESS_REVOKED`, an unreachable Kafuo a retryable 503; preview and
 *   edit grants are never checked.
 * - Behind `ACCESS_CODE`, a learner's media links carry the learner access scope
 *   (`as=`, signed under its own key), and `GET /api/classroom-media/…` repeats
 *   the check before serving. The scope can be neither stripped nor altered; the
 *   admin access cookie is never checked.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { createAccessToken } from '@/lib/server/access-token';
import {
  decodeMediaAccessScope,
  signLearnerMediaUrls,
  verifyClassroomMediaSignature,
} from '@/lib/server/teaching-package/classroom-media-signature';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import { resetLearnerAccessCacheForTests } from '@/lib/server/tutor/learner-access';
import type { LearnerStudentContext } from '@/lib/server/tutor/student-context';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const kafuo = vi.hoisted(() => ({
  answer: { allowed: true } as { allowed: true } | { allowed: false; reason: string } | Error,
  calls: [] as unknown[],
}));

vi.mock('@/lib/server/tutor/kafuo-integration-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/tutor/kafuo-integration-client')>();
  return {
    ...actual,
    getKafuoIntegrationClient: () => ({
      async checkLearnerAccess(request: unknown) {
        kafuo.calls.push(request);
        if (kafuo.answer instanceof Error) throw kafuo.answer;
        return kafuo.answer;
      },
    }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'learner-access-delivery-g2-key';
const ACCESS_CODE = 'learner-access-delivery-code';
const TENANT = 'tenant-g2';
const STAGE = 'stage-g2';
const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';
const AUDIO = `/api/classroom-media/${STAGE}/audio/tts_a1.mp3`;
const SCOPE = {
  tenantId: TENANT,
  studentRef: STUDENT_REF,
  learningItemId: 'li-g2',
  learningItemType: 'lesson',
};

const STUDENT: LearnerStudentContext = {
  studentRef: STUDENT_REF,
  academic: { curriculumName: 'National', curriculumVersionLabel: '2026', gradeLabel: 'Grade 9' },
  subject: { code: 'MATH', nameAr: 'الرياضيات', nameEn: 'Math', academicLanguage: 'ar' },
  entitlements: { help: true },
};

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

function configureIntegration() {
  vi.stubEnv('KAFUO_INTEGRATION_BASE_URL', 'https://kafuo.test/api/v2/integrations/teaching-engine');
  vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec-g2');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('TEACHING_PACKAGE_GRANT_SECRET', '');
  kafuo.answer = { allowed: true };
  kafuo.calls = [];
  resetLearnerAccessCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('learner Stage document reads', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    resetLearnerAccessCacheForTests();
    vi.stubEnv('DATABASE_URL', `postgres://learner-access-g2-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    const slide = makeSlideScene('scene-1', STAGE, 1);
    (slide as { actions?: unknown[] }).actions = [
      { id: 'a1', type: 'speech', text: 'Hello', audioId: 'tts_a1', audioUrl: AUDIO },
    ];
    await store.saveDocument(makeDocument(STAGE, 'G2 lesson', [slide]));
    await insertVersion(pool as never, {
      id: 'tpv-g2',
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-g2' } },
      version: 1,
      status: 'approved',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v3' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  function grantCookie(purpose: 'learner' | 'preview', student: LearnerStudentContext | null = STUDENT) {
    const { token } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId: 'tpv-g2',
      stageId: STAGE,
      capability: 'read',
      purpose,
      ...(student ? { student } : {}),
    });
    return `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, STAGE),
    )}`;
  }

  async function readDocument(cookie: string) {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${STAGE}`, { headers: { cookie } }),
      { poolFactory: () => pool as never },
    );
  }

  it('serves the document while Kafuo allows it, asking for the version learning item', async () => {
    configureIntegration();
    const response = await readDocument(grantCookie('learner'));
    expect(response.status).toBe(200);
    expect(kafuo.calls).toEqual([
      { tenantId: TENANT, studentRef: STUDENT_REF, learningItemId: 'li-g2', learningItemType: 'lesson' },
    ]);
  });

  it('refuses a revoked learner with 403 LEARNER_ACCESS_REVOKED (details.reason)', async () => {
    configureIntegration();
    kafuo.answer = { allowed: false, reason: 'paid_ended_lesson_locked' };
    const response = await readDocument(grantCookie('learner'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'LEARNER_ACCESS_REVOKED',
        message: 'the student can no longer open this lesson',
        details: { reason: 'paid_ended_lesson_locked' },
      },
    });
  });

  it('answers ACCOUNT_INACTIVE for a suspended account', async () => {
    configureIntegration();
    kafuo.answer = { allowed: false, reason: 'account_inactive' };
    const response = await readDocument(grantCookie('learner'));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('fails closed with a retryable 503 when Kafuo cannot answer', async () => {
    configureIntegration();
    const { KafuoUnreachableError } = await import('@/lib/server/tutor/kafuo-integration-client');
    kafuo.answer = new KafuoUnreachableError('down');
    const response = await readDocument(grantCookie('learner'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('LEARNER_ACCESS_UNAVAILABLE');
  });

  it('serves a learner grant without the student block unchecked (no studentRef to check)', async () => {
    configureIntegration();
    kafuo.answer = { allowed: false, reason: 'lesson_on_hold' };
    expect((await readDocument(grantCookie('learner', null))).status).toBe(200);
    expect(kafuo.calls).toEqual([]);
  });

  it('never checks a preview grant', async () => {
    configureIntegration();
    kafuo.answer = { allowed: false, reason: 'lesson_on_hold' };
    expect((await readDocument(grantCookie('preview'))).status).toBe(200);
    expect(kafuo.calls).toEqual([]);
  });

  it('keeps today’s behaviour in development without the integration', async () => {
    kafuo.answer = { allowed: false, reason: 'lesson_on_hold' };
    expect((await readDocument(grantCookie('learner'))).status).toBe(200);
    expect(kafuo.calls).toEqual([]);
  });

  it('signs the learner access scope into every media link (ACCESS_CODE set)', async () => {
    configureIntegration();
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    const body = await (await readDocument(grantCookie('learner'))).text();
    const links = [...body.matchAll(/\/api\/classroom-media\/[^"\\]+/g)].map((m) => m[0]);
    expect(links).toHaveLength(1);
    const url = new URL(links[0]!, 'http://te.test');
    const as = url.searchParams.get('as');
    expect(as).not.toBeNull();
    expect(decodeMediaAccessScope(as!)).toEqual(SCOPE);
    const [, , , classroomId, ...segments] = url.pathname.split('/');
    expect(
      verifyClassroomMediaSignature(
        classroomId!,
        segments,
        url.searchParams.get('exp'),
        url.searchParams.get('sig'),
        Date.now(),
        as,
      ),
    ).toBe(true);
    // Without its scope the same signature is not a valid (v1) link.
    expect(
      verifyClassroomMediaSignature(
        classroomId!,
        segments,
        url.searchParams.get('exp'),
        url.searchParams.get('sig'),
      ),
    ).toBe(false);
  });
});

describe('GET /api/classroom-media with a learner access scope', () => {
  let dir: string;
  const EXP = Math.floor(Date.now() / 1000) + 3600;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'classroom-media-g2-')));
    mkdirSync(join(dir, STAGE, 'audio'), { recursive: true });
    writeFileSync(join(dir, STAGE, 'audio', 'a.mp3'), 'mp3-bytes');
    vi.resetModules();
    resetLearnerAccessCacheForTests();
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', dir);
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    configureIntegration();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(url: string, cookie?: string) {
    const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
    const request = new NextRequest(new URL(url, 'http://te.test'), {
      headers: cookie ? { cookie } : {},
    });
    const [, , , classroomId, ...segments] = request.nextUrl.pathname.split('/');
    return GET(request, {
      params: Promise.resolve({
        classroomId: classroomId!,
        path: segments.map((segment) => decodeURIComponent(segment)),
      }),
    });
  }

  const scopedLink = (scope = SCOPE) =>
    signLearnerMediaUrls(`/api/classroom-media/${STAGE}/audio/a.mp3`, EXP, scope);

  it('serves a scoped link while Kafuo allows the scope (one check per cache window)', async () => {
    const first = await get(scopedLink());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('mp3-bytes');
    expect((await get(scopedLink())).status).toBe(200);
    expect(kafuo.calls).toEqual([SCOPE]);
  });

  it('refuses a scoped link once access is revoked (403), fails closed when Kafuo is down (503)', async () => {
    kafuo.answer = { allowed: false, reason: 'lesson_on_hold' };
    const revoked = await get(scopedLink());
    expect(revoked.status).toBe(403);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: 'LEARNER_ACCESS_REVOKED', details: { reason: 'lesson_on_hold' } },
    });

    resetLearnerAccessCacheForTests();
    const { KafuoUnreachableError } = await import('@/lib/server/tutor/kafuo-integration-client');
    kafuo.answer = new KafuoUnreachableError('down');
    const down = await get(scopedLink());
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('5');
  });

  it('refuses a stripped or altered scope as an invalid link (401)', async () => {
    const url = new URL(scopedLink(), 'http://te.test');
    const stripped = new URL(url);
    stripped.searchParams.delete('as');
    expect((await get(`${stripped.pathname}${stripped.search}`)).status).toBe(401);
    const altered = new URL(url);
    altered.searchParams.set(
      'as',
      Buffer.from(JSON.stringify([TENANT, 'zyxwvutsrqponmlkjihgfedc', 'lesson', 'li-g2'])).toString(
        'base64url',
      ),
    );
    expect((await get(`${altered.pathname}${altered.search}`)).status).toBe(401);
    expect(kafuo.calls).toEqual([]);
  });

  it('never checks the admin access cookie, nor a v1 link', async () => {
    kafuo.answer = { allowed: false, reason: 'lesson_on_hold' };
    const admin = await get(
      `/api/classroom-media/${STAGE}/audio/a.mp3`,
      `openmaic_access=${createAccessToken(ACCESS_CODE)}`,
    );
    expect(admin.status).toBe(200);
    const v1 = signLearnerMediaUrls(`/api/classroom-media/${STAGE}/audio/a.mp3`, EXP);
    expect((await get(v1)).status).toBe(200);
    expect(kafuo.calls).toEqual([]);
  });
});
