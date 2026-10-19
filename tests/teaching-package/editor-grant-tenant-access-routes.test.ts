/**
 * Roles Module phase 1, owner decisions D-O1-1 and D-O1-2 (19 Oct 2026).
 *
 * With `ACCESS_CODE` on, a browser holding no access cookie reaches
 * `GET /api/stage-meta/:id` and `GET /api/classroom-media/:id/…` through the
 * editor-grant exemption. Both handlers then accept only an `edit` or `preview`
 * grant for that Stage whose tenant owns the Stage, the grant a teacher's (or an
 * admin's) editor handoff produces. Learner grants are not accepted: a learner
 * keeps the signed media links. The access cookie and a deployment without
 * `ACCESS_CODE` behave as before.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { createAccessToken } from '@/lib/server/access-token';
import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import { signLearnerMediaUrls } from '@/lib/server/teaching-package/classroom-media-signature';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const CODE = 'd-o1-access-code';
const TENANT = 'tenant-test';
const OTHER_TENANT = 'tenant-other';
const HOURS_9_MS = 9 * 60 * 60 * 1000;

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

type Purpose = 'edit' | 'preview' | 'learner';

describe('D-O1-1 / D-O1-2: the teacher editor grant on stage-meta and classroom-media', () => {
  let pool: PGlitePool;
  let mediaDir: string;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-do1-${(counter += 1)}`;
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://do1-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'do1-grant-key');
    vi.stubEnv('ACCESS_CODE', CODE);
    mediaDir = realpathSync(mkdtempSync(join(tmpdir(), 'do1-classroom-media-')));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', mediaDir);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A tenant's draft Stage: the document, its version, and one audio file. */
  /** A tenant's Stage of one lesson (a fresh lesson unless `lessonId` is given). */
  async function seedStage(
    options: {
      tenantId?: string;
      lessonId?: string;
      version?: number;
      status?: 'draft' | 'approved' | 'superseded';
    } = {},
  ): Promise<{ stageId: string; versionId: string; lessonId: string }> {
    const tenantId = options.tenantId ?? TENANT;
    const lessonId = options.lessonId ?? nextId('li');
    const stageId = nextId('stage');
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(makeDocument(stageId, 'D-O1', [makeSlideScene(`${stageId}-s0`, stageId, 0)]));
    const versionId = nextId('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId, learningItem: { type: 'lesson', id: lessonId } },
      version: options.version ?? 1,
      status: options.status ?? 'draft',
      currentStageId: stageId,
      currentAttemptId: null,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    mkdirSync(join(mediaDir, stageId, 'audio'), { recursive: true });
    writeFileSync(join(mediaDir, stageId, 'audio', 'tts_a1.mp3'), 'mp3-bytes');
    return { stageId, versionId, lessonId };
  }

  function grantToken(
    stageId: string,
    versionId: string,
    options: {
      capability?: 'read' | 'write';
      purpose?: Purpose;
      tenantId?: string;
      now?: number;
    } = {},
  ): string {
    return buildEditorGrantPayload({
      tenantId: options.tenantId ?? TENANT,
      versionId,
      stageId,
      capability: options.capability ?? 'write',
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    }).token;
  }

  const grantCookie = (...tokens: string[]) =>
    `teaching_package_grant=${encodeURIComponent(JSON.stringify(tokens))}`;
  const accessCookie = () => `openmaic_access=${createAccessToken(CODE)}`;

  /** The refusal cases every handler must answer the same way. */
  function refusedCookies(
    stageId: string,
    versionId: string,
    otherStage: string,
    otherVersion: string,
  ) {
    const good = grantToken(stageId, versionId);
    const [body, signature] = good.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    // The other tenant's payload under this grant's original signature.
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const edited = Buffer.from(JSON.stringify({ ...payload, tenantId: OTHER_TENANT })).toString(
      'base64url',
    );
    return {
      'no cookie': undefined,
      'learner grant': grantCookie(
        grantToken(stageId, versionId, { capability: 'read', purpose: 'learner' }),
      ),
      'forged grant': grantCookie('forged.token'),
      'grant with an altered signature': grantCookie(`${body}.${flipped}`),
      'grant with an edited payload': grantCookie(`${edited}.${signature}`),
      'expired grant': grantCookie(
        grantToken(stageId, versionId, { now: Date.now() - HOURS_9_MS }),
      ),
      'another Stage grant': grantCookie(grantToken(otherStage, otherVersion)),
      'another tenant grant': grantCookie(
        grantToken(stageId, versionId, { tenantId: OTHER_TENANT }),
      ),
    } as Record<string, string | undefined>;
  }

  async function stageMeta(stageId: string, cookie?: string): Promise<Response> {
    const { GET } = await import('@/app/api/stage-meta/[stageId]/route');
    const request = new NextRequest(`http://te.test/api/stage-meta/${stageId}`, {
      headers: cookie ? { cookie } : {},
    });
    return GET(request, { params: Promise.resolve({ stageId }) });
  }

  async function media(url: string, cookie?: string): Promise<Response> {
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

  const audioUrl = (stageId: string) => `/api/classroom-media/${stageId}/audio/tts_a1.mp3`;

  describe('GET /api/stage-meta/:id (D-O1-2)', () => {
    it('answers a teacher edit grant with isOwner true, and a preview grant read-only', async () => {
      const { stageId, versionId } = await seedStage();

      const edit = await stageMeta(
        stageId,
        grantCookie(grantToken(stageId, versionId, { purpose: 'edit' })),
      );
      expect(edit.status).toBe(200);
      await expect(edit.json()).resolves.toMatchObject({ isOwner: true });

      const legacyWrite = await stageMeta(stageId, grantCookie(grantToken(stageId, versionId)));
      await expect(legacyWrite.json()).resolves.toMatchObject({ isOwner: true });

      const preview = await stageMeta(
        stageId,
        grantCookie(grantToken(stageId, versionId, { capability: 'read', purpose: 'preview' })),
      );
      expect(preview.status).toBe(200);
      await expect(preview.json()).resolves.toMatchObject({ isOwner: false });
    });

    it('refuses every other caller with the absent-Stage 404 and mints no cookie', async () => {
      const { stageId, versionId } = await seedStage();
      const other = await seedStage();
      const absent = await stageMeta(`stage-never-${randomUUID()}`, accessCookie());
      expect(absent.status).toBe(404);
      const absentBody = await absent.json();

      for (const [label, cookie] of Object.entries(
        refusedCookies(stageId, versionId, other.stageId, other.versionId),
      )) {
        const response = await stageMeta(stageId, cookie);
        expect(response.status, label).toBe(404);
        expect(await response.json(), label).toEqual(absentBody);
        expect(response.headers.get('set-cookie'), label).toBeNull();
        expect(response.headers.get('cache-control'), label).toBe('no-store');
      }
    });

    it('looks the grant up for the exact id it receives (a `.rsc` suffix finds none)', async () => {
      const { stageId, versionId } = await seedStage();
      const response = await stageMeta(
        `${stageId}.rsc`,
        grantCookie(grantToken(stageId, versionId)),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('refuses a grant whose tenant does not own the Stage, even for the right Stage id', async () => {
      const { stageId } = await seedStage({ tenantId: OTHER_TENANT });
      const response = await stageMeta(stageId, grantCookie(grantToken(stageId, 'tpv-x')));
      expect(response.status).toBe(404);
    });

    it('keeps the admin access cookie and a deployment without ACCESS_CODE unchanged', async () => {
      const { stageId } = await seedStage();
      const admin = await stageMeta(stageId, accessCookie());
      expect(admin.status).toBe(200);
      await expect(admin.json()).resolves.toMatchObject({ isOwner: false });

      vi.stubEnv('ACCESS_CODE', '');
      const open = await stageMeta(stageId);
      expect(open.status).toBe(200);
    });
  });

  describe('GET /api/classroom-media/:id/… (D-O1-1)', () => {
    it('serves the Stage media to a teacher edit or preview grant of its own tenant', async () => {
      const { stageId, versionId } = await seedStage();
      for (const token of [
        grantToken(stageId, versionId, { purpose: 'edit' }),
        grantToken(stageId, versionId, { capability: 'read', purpose: 'preview' }),
        grantToken(stageId, versionId),
      ]) {
        const response = await media(audioUrl(stageId), grantCookie(token));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('mp3-bytes');
        // A shared cache may not keep it, exactly as for the access cookie.
        expect(response.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
      }
    });

    it('refuses learner, forged, expired, other-Stage and other-tenant grants (401)', async () => {
      const { stageId, versionId } = await seedStage();
      const other = await seedStage();
      for (const [label, cookie] of Object.entries(
        refusedCookies(stageId, versionId, other.stageId, other.versionId),
      )) {
        const response = await media(audioUrl(stageId), cookie);
        expect(response.status, label).toBe(401);
        expect(response.headers.get('cache-control'), label).toBe('no-store');
      }
    });

    it('keeps the learner signed link working, with or without a learner grant', async () => {
      const { stageId, versionId } = await seedStage();
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const signed = signLearnerMediaUrls(audioUrl(stageId), exp);
      expect(signed).not.toBe(audioUrl(stageId));
      expect((await media(signed)).status).toBe(200);
      const learner = grantCookie(
        grantToken(stageId, versionId, { capability: 'read', purpose: 'learner' }),
      );
      expect((await media(signed, learner)).status).toBe(200);
      expect((await media(audioUrl(stageId), learner)).status).toBe(401);
    });

    it('fails closed when server persistence is not configured', async () => {
      const { stageId, versionId } = await seedStage();
      vi.stubEnv('DATABASE_URL', '');
      const response = await media(audioUrl(stageId), grantCookie(grantToken(stageId, versionId)));
      expect(response.status).toBe(401);
    });

    it('keeps the admin access cookie and a deployment without ACCESS_CODE unchanged', async () => {
      const { stageId } = await seedStage();
      expect((await media(audioUrl(stageId), accessCookie())).status).toBe(200);
      expect((await media(audioUrl(stageId))).status).toBe(401);
      vi.stubEnv('ACCESS_CODE', '');
      const open = await media(audioUrl(stageId));
      expect(open.status).toBe(200);
      expect(open.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    });
  });

  describe('inherited media of the same lesson (D-O1-6)', () => {
    /** An approved version (Stage A) and its draft successor (Stage B) of one lesson. */
    async function seedLessonWithSuccessor() {
      const first = await seedStage({ status: 'approved' });
      const successor = await seedStage({ lessonId: first.lessonId, version: 2 });
      return { first, successor };
    }

    it('serves Stage A media to an edit or preview grant for the successor Stage B', async () => {
      const { first, successor } = await seedLessonWithSuccessor();
      for (const token of [
        grantToken(successor.stageId, successor.versionId, { purpose: 'edit' }),
        grantToken(successor.stageId, successor.versionId, {
          capability: 'read',
          purpose: 'preview',
        }),
      ]) {
        const response = await media(audioUrl(first.stageId), grantCookie(token));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('mp3-bytes');
        expect(response.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
      }
    });

    it('also accepts it when the cookie holds other Stage grants first', async () => {
      const { first, successor } = await seedLessonWithSuccessor();
      const unrelated = await seedStage();
      const cookie = grantCookie(
        grantToken(unrelated.stageId, unrelated.versionId),
        grantToken(successor.stageId, successor.versionId),
      );
      expect((await media(audioUrl(first.stageId), cookie)).status).toBe(200);
    });

    it('refuses a learner grant, another lesson, another tenant and a bad grant', async () => {
      const { first, successor } = await seedLessonWithSuccessor();
      const otherLesson = await seedStage();
      // The same lesson id in another tenant is another tenant's lesson.
      const otherTenantSameLessonId = await seedStage({
        tenantId: OTHER_TENANT,
        lessonId: first.lessonId,
      });
      const successorGrant = grantToken(successor.stageId, successor.versionId);
      const [body, signature] = successorGrant.split('.');
      const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
      const cases: Array<[string, string, string]> = [
        [
          'learner grant for the successor',
          audioUrl(first.stageId),
          grantCookie(
            grantToken(successor.stageId, successor.versionId, {
              capability: 'read',
              purpose: 'learner',
            }),
          ),
        ],
        ["another lesson's Stage", audioUrl(otherLesson.stageId), grantCookie(successorGrant)],
        [
          'the same lesson id in another tenant',
          audioUrl(otherTenantSameLessonId.stageId),
          grantCookie(successorGrant),
        ],
        [
          'a successor grant signed for another tenant',
          audioUrl(first.stageId),
          grantCookie(
            grantToken(successor.stageId, successor.versionId, { tenantId: OTHER_TENANT }),
          ),
        ],
        [
          'an expired successor grant',
          audioUrl(first.stageId),
          grantCookie(
            grantToken(successor.stageId, successor.versionId, { now: Date.now() - HOURS_9_MS }),
          ),
        ],
        ['an altered signature', audioUrl(first.stageId), grantCookie(`${body}.${flipped}`)],
        [
          'a grant naming an unknown version',
          audioUrl(first.stageId),
          grantCookie(grantToken(successor.stageId, 'tpv-unknown')),
        ],
      ];
      for (const [label, url, cookie] of cases) {
        const response = await media(url, cookie);
        expect(response.status, label).toBe(401);
      }
    });

    it('keeps stage-meta to the exact Stage of the grant', async () => {
      const { first, successor } = await seedLessonWithSuccessor();
      const response = await stageMeta(
        first.stageId,
        grantCookie(grantToken(successor.stageId, successor.versionId)),
      );
      expect(response.status).toBe(404);
    });
  });
});
