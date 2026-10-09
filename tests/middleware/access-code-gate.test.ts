/**
 * The `ACCESS_CODE` gate in `middleware.ts` and its allow-list
 * (`lib/config/access-code-allowlist.ts`).
 *
 * Unset: every request passes (unchanged). Set: only the Backend's and the
 * mobile app's routes pass without the `openmaic_access` cookie; every other
 * `/api` request is a 401 until a valid cookie is presented; pages always pass
 * (the frontend shows the access-code modal).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GRANT_COOKIE_NAME } from '@/lib/config/access-code-allowlist';
import { createAccessToken } from '@/lib/server/access-token';
import { TEACHING_PACKAGE_GRANT_COOKIE } from '@/lib/server/teaching-package/editor-grant';
import { middleware } from '@/middleware';

const CODE = 'test-access-code';
const GRANT_COOKIE = `${GRANT_COOKIE_NAME}=opaque-grant`;

function request(method: string, path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'http://te.test'), {
    method,
    headers: cookie ? { cookie } : {},
  });
}

/** `NextResponse.next()` marks the response; a refusal is the 401 JSON. */
async function passes(method: string, path: string, cookie?: string): Promise<boolean> {
  const response = await middleware(request(method, path, cookie));
  if (response.headers.get('x-middleware-next') === '1') return true;
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: 'Access code required' });
  return false;
}

const validCookie = () => `openmaic_access=${createAccessToken(CODE)}`;

/** Routes the Backend (service key) and the mobile app (tokens, grants) call. */
const ALLOWED: ReadonlyArray<[string, string, string?]> = [
  ['GET', '/api/health'],
  ['GET', '/api/access-code/status'],
  ['POST', '/api/access-code/verify'],
  // Backend → TE, service key.
  ['POST', '/api/teaching-packages'],
  ['POST', '/api/teaching-packages/generate'],
  ['GET', '/api/teaching-packages/v1/outline'],
  ['POST', '/api/teaching-packages/v1/editor-handoff'],
  ['POST', '/api/teaching-model/help-turns'],
  ['POST', '/api/tutor/handoff'],
  // Mobile (and admin browser) → TE, handoff tokens and grants.
  ['GET', '/api/teaching-packages/editor-handoff?token=t'],
  ['GET', '/api/tutor/handoff/redeem?token=t'],
  ['GET', '/api/tutor/conversations'],
  ['POST', '/api/tutor/conversations'],
  ['GET', '/api/tutor/conversations/c1'],
  ['POST', '/api/tutor/conversations/c1/messages'],
  ['POST', '/api/tutor/conversations/c1/archive'],
  ['POST', '/api/tutor/conversations/c1/unarchive'],
  ['POST', '/api/tutor/help/turns'],
  ['GET', '/api/tutor/help/sessions?versionId=v&stageId=s&sceneId=x'],
  // Signed at learner delivery; the media route verifies the signature.
  ['GET', '/api/classroom-media/stage-AbC_9-z/media/figure.png?exp=1&sig=s'],
  ['HEAD', '/api/classroom-media/abcDEF1234/audio/scene-1.mp3?exp=1&sig=s'],
  ['GET', '/api/persistence/documents/stage-AbC_9-z', GRANT_COOKIE],
  ['HEAD', '/api/persistence/documents/abcDEF1234', GRANT_COOKIE],
];

/** Everything else under `/api`, including look-alikes of allowed paths. */
const BLOCKED: ReadonlyArray<[string, string, string?]> = [
  ['POST', '/api/chat'],
  ['POST', '/api/generate-classroom'],
  ['POST', '/api/generate/tts'],
  ['GET', '/api/server-providers'],
  ['GET', '/api/usage'],
  ['POST', '/api/agent'],
  ['POST', '/api/speech'],
  ['POST', '/api/web-search'],
  ['POST', '/api/internal/sweep'],
  ['GET', '/api/proxy-media?url=https://example.com'],
  ['POST', '/api/quiz-grade'],
  ['POST', '/api/pbl/v2/task/update'],
  ['GET', '/api/classroom?id=x'],
  // Look-alikes: prefixes stop at a `/` boundary, exact paths are exact.
  ['GET', '/api/tutorial'],
  ['GET', '/api/tutor-x/conversations'],
  ['GET', '/api/tutor'],
  ['POST', '/api/teaching-model/help-turns-x'],
  ['POST', '/api/teaching-model/other'],
  ['POST', '/api/teaching-packagesx'],
  ['GET', '/api/health/details'],
  ['GET', '/api/access-codex/status'],
  // Classroom media: signed reads of media/audio only.
  ['GET', '/api/classroom-media/stage-abc/media/figure.png'],
  ['GET', '/api/classroom-media/stage-abc/media/figure.png?exp=1'],
  ['GET', '/api/classroom-media/stage-abc/media/figure.png?sig=s'],
  ['POST', '/api/classroom-media/stage-abc/media/figure.png?exp=1&sig=s'],
  ['GET', '/api/classroom-media/stage-abc/other/file.png?exp=1&sig=s'],
  ['GET', '/api/classroom-media/stage-abc/media/?exp=1&sig=s'],
  ['GET', '/api/classroom-media/stage%2Fabc/media/figure.png?exp=1&sig=s'],
  // Persistence: one Stage document, read-only, with a grant cookie.
  ['GET', '/api/persistence/documents/stage-abc'],
  ['PUT', '/api/persistence/documents/stage-abc', GRANT_COOKIE],
  ['DELETE', '/api/persistence/documents/stage-abc', GRANT_COOKIE],
  ['GET', '/api/persistence/documents/stage-abc/scenes/s1', GRANT_COOKIE],
  ['GET', '/api/persistence/documents', GRANT_COOKIE],
  ['GET', '/api/persistence/documents/abc%2F..%2Fruntime', GRANT_COOKIE],
  ['GET', '/api/persistence/assets/a1', GRANT_COOKIE],
  ['GET', '/api/persistence/runtime/sessions', GRANT_COOKIE],
];

const PAGES = ['/', '/classroom/stage-abc', '/classroom/stage-abc?mode=edit'];

describe('ACCESS_CODE gate', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ACCESS_CODE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ACCESS_CODE;
    else process.env.ACCESS_CODE = saved;
  });

  describe('with ACCESS_CODE unset', () => {
    beforeEach(() => {
      delete process.env.ACCESS_CODE;
    });

    it('lets every request through, as before', async () => {
      for (const [method, path, cookie] of [...ALLOWED, ...BLOCKED]) {
        expect(await passes(method, path, cookie), `${method} ${path}`).toBe(true);
      }
      for (const path of PAGES) expect(await passes('GET', path), path).toBe(true);
    });
  });

  describe('with ACCESS_CODE set', () => {
    beforeEach(() => {
      process.env.ACCESS_CODE = CODE;
    });

    it('lets the Backend and mobile routes through without the access cookie', async () => {
      for (const [method, path, cookie] of ALLOWED) {
        expect(await passes(method, path, cookie), `${method} ${path}`).toBe(true);
      }
    });

    it('answers 401 to every other /api request without the access cookie', async () => {
      for (const [method, path, cookie] of BLOCKED) {
        expect(await passes(method, path, cookie), `${method} ${path}`).toBe(false);
      }
    });

    it('lets a blocked /api request through with a valid access cookie', async () => {
      for (const [method, path, cookie] of BLOCKED) {
        const cookies = [validCookie(), cookie].filter(Boolean).join('; ');
        expect(await passes(method, path, cookies), `${method} ${path}`).toBe(true);
      }
    });

    it('refuses a forged or foreign access cookie', async () => {
      const forged = `openmaic_access=${Date.now()}.${'0'.repeat(64)}`;
      const foreign = `openmaic_access=${createAccessToken('another-code')}`;
      for (const cookie of [forged, foreign, 'openmaic_access=garbage']) {
        expect(await passes('POST', '/api/chat', cookie), cookie).toBe(false);
      }
    });

    it('lets pages through without the cookie (the frontend shows the modal)', async () => {
      for (const path of PAGES) expect(await passes('GET', path), path).toBe(true);
    });
  });

  it('checks the same grant cookie name the persistence route verifies', () => {
    expect(GRANT_COOKIE_NAME).toBe(TEACHING_PACKAGE_GRANT_COOKIE);
  });
});

/**
 * The prefixes are only safe while every route under them authenticates on its
 * own. A new route there must use one of these, or this test fails and the
 * allow-list has to be revisited.
 */
describe('routes under the open prefixes authenticate on their own', () => {
  const API_DIR = join(__dirname, '..', '..', 'app', 'api');
  const OWN_AUTH =
    /authenticateServiceRequest|withStudentGrant|withLearnerGrant|redeemStudentHandoff|verifyEditorHandoffToken/;
  /** Reviewed exceptions: no credential needed, nothing to protect. */
  const EXEMPT = new Set([
    // Clears the caller's own grant cookies; reads and writes nothing else.
    'teaching-packages/editor-handoff/release/route.ts',
  ]);

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return name === 'route.ts' ? [full] : [];
    });
  }

  it.each(['tutor', 'teaching-packages', 'teaching-model/help-turns'])('%s', (folder) => {
    const files = routeFiles(join(API_DIR, folder));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const name = relative(API_DIR, file);
      if (EXEMPT.has(name)) continue;
      expect(readFileSync(file, 'utf8'), name).toMatch(OWN_AUTH);
    }
  });
});
