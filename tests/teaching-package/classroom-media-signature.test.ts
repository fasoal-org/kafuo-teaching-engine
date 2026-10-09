/**
 * Signed classroom-media links behind `ACCESS_CODE`
 * (`lib/server/teaching-package/classroom-media-signature.ts`).
 *
 * A learner's Stage document is delivered with every classroom-media link
 * signed until the grant expires; the media route then serves a read only with
 * a valid signature for exactly that file, or with the browser's access
 * cookie. Without `ACCESS_CODE` nothing changes.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { createAccessToken } from '@/lib/server/access-token';
import {
  canReadGatedClassroomMedia,
  signLearnerMediaUrls,
  verifyClassroomMediaSignature,
} from '@/lib/server/teaching-package/classroom-media-signature';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { encodeSigned } from '@/lib/server/teaching-package/signed-token';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const SERVICE_KEY = 'media-signature-service-key';
const ACCESS_CODE = 'media-access-code';
const EXP = 4_000_000_000; // seconds, far future

/** The `exp` / `sig` a signed link carries, plus its path. */
function parse(url: string) {
  const parsed = new URL(url, 'http://te.test');
  return {
    pathname: parsed.pathname,
    exp: parsed.searchParams.get('exp'),
    sig: parsed.searchParams.get('sig'),
    search: parsed.searchParams,
  };
}

const sign = (url: string, exp = EXP) => signLearnerMediaUrls(url, exp);

beforeEach(() => {
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('TEACHING_PACKAGE_GRANT_SECRET', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signLearnerMediaUrls', () => {
  it('signs relative and absolute media/audio links, and keeps an existing query', () => {
    const relative = sign('/api/classroom-media/stage-a/media/fig.png');
    expect(relative).toMatch(
      /^\/api\/classroom-media\/stage-a\/media\/fig\.png\?exp=4000000000&sig=[A-Za-z0-9_-]{43}$/,
    );
    const absolute = sign('https://te.test/api/classroom-media/stage-a/audio/a.mp3');
    expect(absolute).toMatch(/^https:\/\/te\.test\/api\/classroom-media\/stage-a\/audio\/a\.mp3\?exp=\d+&sig=/);
    const withQuery = sign('/api/classroom-media/stage-a/media/fig.png?v=2');
    expect(withQuery).toMatch(/\/fig\.png\?exp=4000000000&sig=[A-Za-z0-9_-]+&v=2$/);
    expect(parse(withQuery).search.get('v')).toBe('2');
  });

  it('signs every link inside HTML and CSS strings, each for its own file', () => {
    const html =
      '<img src="/api/classroom-media/stage-a/media/a.png"><div style="background:url(/api/classroom-media/stage-b/media/b.png)"></div>';
    const signed = sign(html);
    const links = [...signed.matchAll(/\/api\/classroom-media\/[^"')]+/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatch(/^\/api\/classroom-media\/stage-a\/media\/a\.png\?exp=\d+&sig=/);
    expect(links[1]).toMatch(/^\/api\/classroom-media\/stage-b\/media\/b\.png\?exp=\d+&sig=/);
    expect(parse(links[0]!).sig).not.toBe(parse(links[1]!).sig);
  });

  it('walks objects and arrays without mutating the input, and leaves other strings alone', () => {
    const input = {
      title: 'Lesson',
      other: '/api/classroom-media/stage-a/other/x.png',
      notMedia: '/api/persistence/documents/stage-a',
      scenes: [{ src: '/api/classroom-media/stage-a/media/fig.png', n: 3, ok: true, none: null }],
    };
    const snapshot = structuredClone(input);
    const signed = signLearnerMediaUrls(input, EXP);
    expect(input).toEqual(snapshot);
    expect(signed.title).toBe('Lesson');
    expect(signed.other).toBe(input.other);
    expect(signed.notMedia).toBe(input.notMedia);
    expect(signed.scenes[0]!.src).toMatch(/\?exp=\d+&sig=/);
    expect(signed.scenes[0]).toMatchObject({ n: 3, ok: true, none: null });
  });

  it('changes nothing when no signing key is configured', () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    const input = { src: '/api/classroom-media/stage-a/media/fig.png' };
    expect(signLearnerMediaUrls(input, EXP)).toBe(input);
  });
});

describe('verifyClassroomMediaSignature', () => {
  const NOW = 1_800_000_000_000;

  it('accepts the signed link for exactly that file until it expires', () => {
    const { exp, sig } = parse(sign('/api/classroom-media/stage-a/media/fig.png'));
    expect(verifyClassroomMediaSignature('stage-a', ['media', 'fig.png'], exp, sig, NOW)).toBe(true);
    // Expired.
    expect(
      verifyClassroomMediaSignature('stage-a', ['media', 'fig.png'], exp, sig, EXP * 1000 + 1),
    ).toBe(false);
  });

  it('refuses another file, another Stage, a moved expiry, a tampered or missing signature', () => {
    const { exp, sig } = parse(sign('/api/classroom-media/stage-a/media/fig.png'));
    const check = (id: string, segments: string[], e: string | null, s: string | null) =>
      verifyClassroomMediaSignature(id, segments, e, s, NOW);
    expect(check('stage-a', ['media', 'other.png'], exp, sig)).toBe(false);
    expect(check('stage-a', ['audio', 'fig.png'], exp, sig)).toBe(false);
    expect(check('stage-b', ['media', 'fig.png'], exp, sig)).toBe(false);
    expect(check('stage-a', ['media', 'fig.png'], String(EXP + 1), sig)).toBe(false);
    expect(check('stage-a', ['media', 'fig.png'], exp, `${sig!.slice(0, -1)}A`)).toBe(false);
    expect(check('stage-a', ['media', 'fig.png'], exp, null)).toBe(false);
    expect(check('stage-a', ['media', 'fig.png'], null, sig)).toBe(false);
    expect(check('stage-a', ['media', 'fig.png'], '1e12', sig)).toBe(false);
  });

  it('signs the decoded path the route receives (percent-encoded file names)', () => {
    const { exp, sig } = parse(sign('/api/classroom-media/stage-a/media/my%20fig%2B1.png'));
    expect(
      verifyClassroomMediaSignature('stage-a', ['media', 'my fig+1.png'], exp, sig, NOW),
    ).toBe(true);
  });

  it('uses its own key: a grant-secret HMAC of the same message is not a valid signature', () => {
    const { exp } = parse(sign('/api/classroom-media/stage-a/media/fig.png'));
    const grantToken = encodeSigned({ kind: 'grant', stageId: 'stage-a' });
    const rawSig = grantToken.slice(grantToken.indexOf('.') + 1);
    expect(
      verifyClassroomMediaSignature('stage-a', ['media', 'fig.png'], exp, rawSig, NOW),
    ).toBe(false);
  });

  it('refuses everything when no signing key is configured', () => {
    const { exp, sig } = parse(sign('/api/classroom-media/stage-a/media/fig.png'));
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect(verifyClassroomMediaSignature('stage-a', ['media', 'fig.png'], exp, sig, NOW)).toBe(
      false,
    );
  });

  it('lets the browser access cookie read a plain link', () => {
    const base = {
      accessCode: ACCESS_CODE,
      classroomId: 'stage-a',
      segments: ['media', 'fig.png'],
      searchParams: new URLSearchParams(),
    };
    expect(
      canReadGatedClassroomMedia({ ...base, accessCookie: createAccessToken(ACCESS_CODE) }),
    ).toBe(true);
    expect(
      canReadGatedClassroomMedia({ ...base, accessCookie: createAccessToken('another-code') }),
    ).toBe(false);
    expect(canReadGatedClassroomMedia({ ...base, accessCookie: undefined })).toBe(false);
  });
});

describe('GET /api/classroom-media behind ACCESS_CODE', () => {
  let dir: string;

  beforeEach(() => {
    // Real path: the route compares realpaths (macOS tmp is under a /var symlink).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'classroom-media-')));
    mkdirSync(join(dir, 'stage-a', 'audio'), { recursive: true });
    writeFileSync(join(dir, 'stage-a', 'audio', 'a.mp3'), 'mp3-bytes');
    writeFileSync(join(dir, 'stage-a', 'audio', 'my fig.mp3'), 'spaced-bytes');
    vi.resetModules();
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(url: string, cookie?: string) {
    const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
    const request = new NextRequest(new URL(url, 'http://te.test'), {
      headers: cookie ? { cookie } : {},
    });
    // Next hands the route DECODED segments.
    const [, , , classroomId, ...segments] = request.nextUrl.pathname.split('/');
    return GET(request, {
      params: Promise.resolve({
        classroomId: classroomId!,
        path: segments.map((segment) => decodeURIComponent(segment)),
      }),
    });
  }

  it('serves a plain link openly when ACCESS_CODE is unset (unchanged)', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    const response = await get('/api/classroom-media/stage-a/audio/a.mp3');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
  });

  it('refuses a plain, expired, foreign or tampered link and serves a signed one', async () => {
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    const plain = await get('/api/classroom-media/stage-a/audio/a.mp3');
    expect(plain.status).toBe(401);
    expect(plain.headers.get('cache-control')).toBe('no-store');

    const signed = await get(sign('/api/classroom-media/stage-a/audio/a.mp3'));
    expect(signed.status).toBe(200);
    expect(await signed.text()).toBe('mp3-bytes');
    expect(signed.headers.get('cache-control')).toBe('private, max-age=86400, immutable');

    const past = Math.floor(Date.now() / 1000) - 60;
    expect((await get(sign('/api/classroom-media/stage-a/audio/a.mp3', past))).status).toBe(401);

    // A signature for one file never opens another.
    const { search } = parse(sign('/api/classroom-media/stage-a/audio/other.mp3'));
    expect((await get(`/api/classroom-media/stage-a/audio/a.mp3?${search}`)).status).toBe(401);
  });

  it('serves a signed percent-encoded file name', async () => {
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    const response = await get(sign('/api/classroom-media/stage-a/audio/my%20fig.mp3'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('spaced-bytes');
  });

  it('serves a plain link to a browser holding the access cookie', async () => {
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    const response = await get(
      '/api/classroom-media/stage-a/audio/a.mp3',
      `openmaic_access=${createAccessToken(ACCESS_CODE)}`,
    );
    expect(response.status).toBe(200);
  });
});

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

describe('learner Stage document delivery', () => {
  const TENANT = 'tenant-media';
  const STAGE = 'stage-media-v2';
  const SOURCE_STAGE = 'stage-media-v1';
  const IMAGE = `/api/classroom-media/${SOURCE_STAGE}/media/fig.png`;
  const AUDIO = `/api/classroom-media/${STAGE}/audio/tts_a1.mp3`;
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', `postgres://media-signature-${randomUUID()}`);
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
    // A successor Stage: its image still lives under the SOURCE Stage id.
    const slide = makeSlideScene('scene-1', STAGE, 1);
    (slide.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'el-image',
      type: 'image',
      src: IMAGE,
    });
    (slide as { actions?: unknown[] }).actions = [
      { id: 'a1', type: 'speech', text: 'Hello', audioId: 'tts_a1', audioUrl: AUDIO },
    ];
    await store.saveDocument(makeDocument(STAGE, 'Media lesson', [slide]));
    await insertVersion(pool as never, {
      id: 'tpv-media',
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-media' } },
      version: 2,
      status: 'approved',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v3' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  function grantCookie(purpose: 'learner' | 'preview') {
    const { token, payload } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId: 'tpv-media',
      stageId: STAGE,
      capability: 'read',
      purpose,
    });
    return {
      exp: payload.exp,
      cookie: `teaching_package_grant=${encodeURIComponent(
        grantCookieValueForRedeem(new Headers(), token, STAGE),
      )}`,
    };
  }

  async function readDocument(cookie: string): Promise<string> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${STAGE}`, { headers: { cookie } }),
      { poolFactory: () => pool as never },
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  const links = (body: string) =>
    [...body.matchAll(/\/api\/classroom-media\/[^"\\]+/g)].map((match) => match[0]);

  it('signs every media link for a learner until the grant expires (ACCESS_CODE set)', async () => {
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    const { cookie, exp } = grantCookie('learner');
    const delivered = links(await readDocument(cookie));
    expect(delivered).toHaveLength(2);
    const expSeconds = String(Math.floor(exp / 1000));
    for (const link of delivered) {
      const { pathname, exp: linkExp, sig } = parse(link);
      expect(linkExp).toBe(expSeconds);
      const [, , , classroomId, ...segments] = pathname.split('/');
      expect(verifyClassroomMediaSignature(classroomId!, segments, linkExp, sig)).toBe(true);
    }
    // The successor's image keeps its source Stage id and is still signed.
    expect(delivered.some((link) => link.startsWith(`${IMAGE}?exp=`))).toBe(true);
  });

  it('leaves links unsigned without ACCESS_CODE, and for a preview grant', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    expect(links(await readDocument(grantCookie('learner').cookie)).sort()).toEqual(
      [AUDIO, IMAGE].sort(),
    );
    vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
    expect(links(await readDocument(grantCookie('preview').cookie)).sort()).toEqual(
      [AUDIO, IMAGE].sort(),
    );
  });
});
