/**
 * Roles phase 1, O1 (D-8 B): the editor-grant exemption of the `ACCESS_CODE`
 * gate (`isEditorGrantExemptRequest` in `lib/config/access-code-allowlist.ts`).
 *
 * - A request carrying only the `teaching_package_grant` cookie (presence only)
 *   reaches exactly the reviewed method + path table; each handler there
 *   verifies the grant itself.
 * - Every other route, every other method on those paths (HEAD and OPTIONS
 *   included) and every look-alike keeps the 401.
 * - Closed mode keeps the 503; the access cookie behaves as before; the
 *   learner document rule (row 11) is unchanged.
 *
 * - Owner decisions D-O1-1 / D-O1-2 (19 Oct 2026): `GET /api/stage-meta/:id`
 *   joins the table, and GET/HEAD reads of `classroom-media/:id/(media|audio)/…`
 *   pass with the grant cookie. Both handlers accept only an edit/preview grant
 *   for that Stage of its own tenant (route tests in
 *   `tests/teaching-package/editor-grant-tenant-access-routes.test.ts`).
 * - Owner decision D-O1-R8 (19 Oct 2026), CSRF: the POST rows 6, 8 and 10 pass
 *   only with `Sec-Fetch-Site: same-origin`, or, when that header is absent, an
 *   `Origin` equal to the request's public origin. GET, PUT and DELETE rows and
 *   the access cookie ignore fetch headers.
 *
 * Reviewed list: `docs/frds/roles/roles-module-phase-1-o1-route-inventory-review.md` §6.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EDITOR_GRANT_EXEMPT_ROUTES,
  GRANT_COOKIE_NAME,
  isEditorGrantExemptRequest,
} from '@/lib/config/access-code-allowlist';
import { createAccessToken } from '@/lib/server/access-token';
import { middleware } from '@/middleware';

const CODE = 'test-access-code';
const GRANT = `${GRANT_COOKIE_NAME}=opaque-grant`;
const accessCookie = () => `openmaic_access=${createAccessToken(CODE)}`;

/** The reviewed Option A list (inventory rows 1-10 and 12-16), in order. */
const REVIEWED: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/stages/:id/teaching-skills'], // 1
  ['PUT', '/api/stages/:id/teaching-skills'], // 2
  ['PUT', '/api/stages/:id/scene-alignment-confirmations'], // 3 (D-7 A)
  ['GET', '/api/stages/:id/scene-regeneration'], // 4
  ['GET', '/api/stages/:id/scene-regenerations/:id'], // 5
  ['POST', '/api/stages/:id/scene-regenerations/:id/restore'], // 6
  ['GET', '/api/stages/:id/scene-revisions'], // 7
  ['POST', '/api/stages/:id/scenes/:id/regenerate'], // 8
  ['GET', '/api/stages/:id/scenes/:id/regenerate'], // 9
  ['POST', '/api/stages/:id/scenes/:id/narration-audio'], // 10
  ['PUT', '/api/persistence/documents/:id'], // 12
  ['PUT', '/api/persistence/documents/:id/stage'], // 13
  ['GET', '/api/persistence/documents/:id/scenes/:id'], // 14
  ['PUT', '/api/persistence/documents/:id/scenes/:id'], // 15
  ['DELETE', '/api/persistence/documents/:id/scenes/:id'], // 16
  ['GET', '/api/stage-meta/:id'], // x10 (D-O1-2, owner 19 Oct 2026)
];

/** The handler file behind each reviewed Stage path (`app/api/…`). */
const STAGE_ROUTE_FILES: Readonly<Record<string, string>> = {
  '/api/stages/:id/teaching-skills': 'stages/[id]/teaching-skills/route.ts',
  '/api/stages/:id/scene-alignment-confirmations':
    'stages/[id]/scene-alignment-confirmations/route.ts',
  '/api/stages/:id/scene-regeneration': 'stages/[id]/scene-regeneration/route.ts',
  '/api/stages/:id/scene-regenerations/:id':
    'stages/[id]/scene-regenerations/[regenerationId]/route.ts',
  '/api/stages/:id/scene-regenerations/:id/restore':
    'stages/[id]/scene-regenerations/[regenerationId]/restore/route.ts',
  '/api/stages/:id/scene-revisions': 'stages/[id]/scene-revisions/route.ts',
  '/api/stages/:id/scenes/:id/regenerate': 'stages/[id]/scenes/[sceneId]/regenerate/route.ts',
  '/api/stages/:id/scenes/:id/narration-audio':
    'stages/[id]/scenes/[sceneId]/narration-audio/route.ts',
  '/api/stage-meta/:id': 'stage-meta/[stageId]/route.ts',
};
const PERSISTENCE_ROUTE_FILE = 'persistence/[...path]/route.ts';

const STAGE = 'stage-AbC_9-z';
/** A scene or regeneration id (`tsr-<base64url>`); same charset. */
const CHILD = 'tsr-Q1w_2e-3R';
const S = STAGE;

/** `:id` placeholders filled in order: the Stage, then the scene/regeneration id. */
function fill(template: string): string {
  const ids = [STAGE, CHILD];
  let index = 0;
  return template.replace(/:id/g, () => ids[index++]);
}

/** One concrete request per reviewed row. */
const ROWS = REVIEWED.map(([method, template]) => [method, fill(template)] as const);

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** What a browser sends on the TE editor's own fetches (D-O1-R8). */
const SAME_ORIGIN: Readonly<Record<string, string>> = { 'sec-fetch-site': 'same-origin' };

/**
 * `fetchHeaders` defaults to `SAME_ORIGIN` when the cookie carries the grant
 * cookie (the editor's own request), and to none otherwise; `{}` sends none.
 */
function request(
  method: string,
  path: string,
  cookie?: string,
  fetchHeaders?: Readonly<Record<string, string>>,
): NextRequest {
  const headers: Record<string, string> = {
    ...(fetchHeaders ?? (cookie?.includes(`${GRANT_COOKIE_NAME}=`) ? SAME_ORIGIN : {})),
  };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(new URL(path, 'http://te.test'), { method, headers });
}

/** `passed`, or the refusal status. */
async function outcome(
  method: string,
  path: string,
  cookie?: string,
  fetchHeaders?: Readonly<Record<string, string>>,
): Promise<'passed' | number> {
  const response = await middleware(request(method, path, cookie, fetchHeaders));
  if (response.headers.get('x-middleware-next') === '1') return 'passed';
  return response.status;
}

/** Rows 6, 8 and 10: the only POST rows, the only ones a cross-site form can send. */
const POST_ROWS = ROWS.filter(([method]) => method === 'POST');
/** Every other row: GET, PUT and DELETE. */
const NON_POST_ROWS = ROWS.filter(([method]) => method !== 'POST');

/** Fetch-metadata headers that are not the TE's own origin. */
const NOT_SAME_ORIGIN: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  ['same-site', { 'sec-fetch-site': 'same-site' }],
  ['cross-site', { 'sec-fetch-site': 'cross-site' }],
  ['none', { 'sec-fetch-site': 'none' }],
  ['empty Sec-Fetch-Site', { 'sec-fetch-site': '' }],
  ['no fetch headers', {}],
  // Sec-Fetch-Site decides when present, even next to a matching Origin.
  ['same-site with a matching Origin', { 'sec-fetch-site': 'same-site', origin: 'http://te.test' }],
  [
    'cross-site with a matching Origin',
    { 'sec-fetch-site': 'cross-site', origin: 'http://te.test' },
  ],
];

/** Routes that must keep the access code even with a grant cookie. */
const NOT_EXEMPT: ReadonlyArray<readonly [string, string]> = [
  // Generic and owner-scoped Stage routes: no grant.
  ['GET', `/api/stages/${S}`],
  ['PATCH', `/api/stages/${S}`],
  ['PUT', `/api/stages/${S}`],
  ['DELETE', `/api/stages/${S}`],
  ['GET', '/api/stages'],
  ['POST', '/api/stages'],
  ['POST', `/api/stages/${S}/publish`],
  ['POST', `/api/stages/${S}/unpublish`],
  ['GET', `/api/stages/${S}/manifest`],
  ['GET', `/api/stages/${S}/freshness`],
  ['GET', `/api/stages/${S}/status`],
  ['GET', `/api/stages/${S}/scenes`],
  ['POST', `/api/stages/${S}/generation-complete`],
  // Generation, chat, speech, provider and probe routes (server keys).
  ['POST', '/api/generate/tts'],
  ['POST', '/api/generate/tts/assess'],
  ['POST', '/api/generate/scene-content'],
  ['POST', '/api/generate/image'],
  ['POST', '/api/generate-classroom'],
  ['GET', '/api/generate-classroom/job-1'],
  ['POST', '/api/chat'],
  ['POST', '/api/chat/pi'],
  ['GET', '/api/speech/diagnostics'],
  ['GET', '/api/server-providers'],
  ['POST', '/api/provider/probe-models'],
  ['POST', '/api/verify-model'],
  ['POST', '/api/quiz-grade'],
  ['GET', '/api/agent/runtime'],
  ['GET', '/api/azure-voices'],
  ['GET', '/api/materials'],
  ['GET', '/api/routing/subjects'],
  // Persistence runtime (inventory rows 17-24 and x4-x6): learner progress.
  ['POST', '/api/persistence/runtime/sessions'],
  ['GET', '/api/persistence/runtime/sessions/session-1'],
  ['PATCH', '/api/persistence/runtime/sessions/session-1/status'],
  ['DELETE', '/api/persistence/runtime/sessions/session-1'],
  ['POST', '/api/persistence/runtime/sessions/session-1/records'],
  ['GET', '/api/persistence/runtime/sessions/session-1/records'],
  ['GET', `/api/persistence/runtime/stages/${S}/learners/tp%3Aabc/sessions`],
  ['DELETE', `/api/persistence/runtime/stages/${S}/learners/tp%3Aabc`],
  ['DELETE', '/api/persistence/runtime'],
  ['DELETE', `/api/persistence/runtime/stages/${S}`],
  ['POST', '/api/persistence/runtime/learners/merge'],
  // Assets (x7-x9).
  ['POST', '/api/persistence/assets'],
  ['GET', '/api/persistence/assets/asset-1/content'],
  ['HEAD', '/api/persistence/assets/asset-1/content'],
  ['PUT', '/api/persistence/assets/asset-1/content'],
  ['DELETE', '/api/persistence/assets/asset-1'],
  // Documents outside the table (x1-x3).
  ['DELETE', `/api/persistence/documents/${S}`],
  ['GET', '/api/persistence/documents'],
  ['POST', '/api/persistence/documents'],
  ['POST', `/api/persistence/documents/${S}`],
  ['PATCH', `/api/persistence/documents/${S}`],
  ['POST', `/api/persistence/documents/${S}/scenes`],
  ['PATCH', `/api/persistence/documents/${S}/scenes/${CHILD}`],
  // Classroom media (x11) outside the D-O1-1 read rule: writes and other folders.
  ['POST', `/api/classroom-media/${S}/media/figure.png`],
  ['PUT', `/api/classroom-media/${S}/audio/scene-1.mp3`],
  ['DELETE', `/api/classroom-media/${S}/media/figure.png`],
  ['OPTIONS', `/api/classroom-media/${S}/media/figure.png`],
  ['GET', `/api/classroom-media/${S}/other/file.png`],
  ['GET', `/api/classroom-media/${S}/media/`],
  ['GET', `/api/classroom-media/stage%2Fabc/media/figure.png`],
];

/** Look-alikes of reviewed paths, all under `/api/`. */
const LOOK_ALIKES: ReadonlyArray<readonly [string, string]> = [
  // Trailing slash and extra segments.
  ['GET', `/api/stages/${S}/teaching-skills/`],
  ['PUT', `/api/stages/${S}/scene-alignment-confirmations/x`],
  ['POST', `/api/stages/${S}/scenes/${CHILD}/regenerate/extra`],
  ['PUT', `/api/persistence/documents/${S}/`],
  ['PUT', `/api/persistence/documents/${S}/stage/x`],
  ['DELETE', `/api/persistence/documents/${S}/scenes/${CHILD}/x`],
  // Missing or empty segments.
  ['GET', '/api/stages//teaching-skills'],
  ['GET', `/api/stages/${S}/scene-regenerations`],
  ['POST', `/api/stages/${S}/scene-regenerations/restore`],
  ['POST', `/api/stages/${S}/scenes/regenerate`],
  ['PUT', `/api/persistence/documents/${S}/scenes`],
  // Prefix and suffix look-alikes.
  ['GET', `/api/stagesx/${S}/teaching-skills`],
  ['GET', `/api/stages/${S}/teaching-skillsx`],
  ['GET', `/api/stages/${S}/scene-regenerationx`],
  ['GET', `/api/stages/${S}/scene-revisions-x`],
  ['PUT', `/api/persistence/documentsx/${S}/stage`],
  ['PUT', `/api/persistencex/documents/${S}`],
  // Encoded separators, dot segments and characters outside the id charset.
  ['GET', `/api/stages/${S}%2Fteaching-skills`],
  ['PUT', `/api/stages/a%2F..%2F${S}/teaching-skills`],
  ['PUT', '/api/persistence/documents/abc%2F..%2Fruntime/stage'],
  ['POST', `/api/stages/${S}/scenes/${CHILD}%2Fx/regenerate`],
  ['GET', `/api/stages/${S}/scenes/..%2F${CHILD}/regenerate`],
  ['POST', `/api/stages/${S}/teaching-skills/../publish`],
  ['GET', '/api/stages/stage.abc/teaching-skills'],
  ['GET', '/api/stages/stage%20abc/teaching-skills'],
  ['GET', `/api/stages/${S}/teaching-skills%00`],
  // Case variants of the literal segments.
  ['GET', `/api/Stages/${S}/teaching-skills`],
  ['GET', `/api/stages/${S}/Teaching-Skills`],
  ['PUT', `/api/persistence/Documents/${S}/stage`],
  ['PUT', `/api/persistence/documents/${S}/STAGE`],
  // A query string carries no route.
  ['POST', `/api/stages/${S}/publish?next=/teaching-skills`],
  ['GET', `/api/stages/${S}?path=/teaching-skills`],
];

/**
 * Outside `/api/` the middleware treats a path as a page (unchanged), so these
 * are checked against the predicate only.
 */
const NON_API_LOOK_ALIKES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `/API/stages/${S}/teaching-skills`],
  ['PUT', `/Api/persistence/documents/${S}/stage`],
  ['GET', `/apix/stages/${S}/teaching-skills`],
  ['GET', `/x/api/stages/${S}/teaching-skills`],
];

describe('editor-grant exemption (O1)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '');
    vi.stubEnv('ACCESS_CODE', CODE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('with ACCESS_CODE set', () => {
    it('lets each reviewed row through with only a grant cookie', async () => {
      for (const [method, path] of ROWS) {
        expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe('passed');
      }
    });

    it('lets a teacher write grant reach PUT scene-alignment-confirmations (D-7 A)', async () => {
      const path = `/api/stages/${S}/scene-alignment-confirmations`;
      expect(await outcome('PUT', path, GRANT)).toBe('passed');
      // The service-key twin keeps its existing prefix rule, unchanged.
      expect(
        await outcome('PUT', '/api/teaching-packages/pkg-1/scene-alignment-confirmations'),
      ).toBe('passed');
    });

    it('lets classroom media reads through with only a grant cookie (D-O1-1)', async () => {
      const reads: ReadonlyArray<readonly [string, string]> = [
        ['GET', `/api/classroom-media/${S}/media/figure.png`],
        ['HEAD', `/api/classroom-media/${S}/audio/scene-1.mp3`],
        ['GET', `/api/classroom-media/${S}/audio/nested/tts_a1.mp3`],
      ];
      for (const [method, path] of reads) {
        expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe('passed');
        expect(await outcome(method, path), `${method} ${path} no cookie`).toBe(401);
        expect(
          await outcome(method, path, 'teaching_package_learner_key=tp:abc'),
          `${method} ${path} learner key only`,
        ).toBe(401);
      }
      // The signed-link rule is unchanged and needs no cookie at all.
      expect(await outcome('GET', `/api/classroom-media/${S}/media/figure.png?exp=1&sig=s`)).toBe(
        'passed',
      );
    });

    it('ignores the query string', async () => {
      expect(
        await outcome('GET', `/api/stages/${S}/scenes/${CHILD}/regenerate?key=idem-1`, GRANT),
      ).toBe('passed');
      expect(await outcome('PUT', `/api/persistence/documents/${S}?x=1`, GRANT)).toBe('passed');
    });

    it('still passes with a forged or stale access cookie next to the grant cookie', async () => {
      const forged = `openmaic_access=v2.${Date.now()}.${'0'.repeat(64)}`;
      for (const [method, path] of ROWS) {
        expect(await outcome(method, path, `${forged}; ${GRANT}`), `${method} ${path}`).toBe(
          'passed',
        );
      }
    });

    it('answers 401 on every row without a grant cookie', async () => {
      const others = [undefined, `${GRANT_COOKIE_NAME}=`, 'teaching_package_learner_key=tp:abc'];
      for (const [method, path] of ROWS) {
        for (const cookie of others) {
          expect(await outcome(method, path, cookie), `${method} ${path} ${cookie}`).toBe(401);
        }
      }
      const response = await middleware(request('PUT', ROWS[1][1]));
      expect(await response.json()).toMatchObject({ error: 'Access code required' });
    });

    it('answers 401 to the excluded routes even with a grant cookie', async () => {
      for (const [method, path] of NOT_EXEMPT) {
        expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe(401);
      }
    });

    it('answers 401 to un-inventoried methods, HEAD and OPTIONS on reviewed paths', async () => {
      const learnerDocument = `/api/persistence/documents/${S}`;
      const paths = [...new Set(ROWS.map(([, path]) => path))];
      for (const path of paths) {
        for (const method of METHODS) {
          if (ROWS.some((row) => row[0] === method && row[1] === path)) continue;
          // Row 11: the learner document read keeps its GET/HEAD rule.
          if (path === learnerDocument && (method === 'GET' || method === 'HEAD')) continue;
          expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe(401);
        }
      }
    });

    it('keeps the learner document rule (row 11) unchanged', async () => {
      const path = `/api/persistence/documents/${S}`;
      expect(await outcome('GET', path, GRANT)).toBe('passed');
      expect(await outcome('HEAD', path, GRANT)).toBe('passed');
      expect(await outcome('GET', path)).toBe(401);
    });

    it('answers 401 to look-alikes of reviewed paths', async () => {
      for (const [method, path] of LOOK_ALIKES) {
        expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe(401);
      }
    });

    it('does not match look-alikes outside /api/ either', () => {
      for (const [method, path] of [...LOOK_ALIKES, ...NON_API_LOOK_ALIKES]) {
        const matched = isEditorGrantExemptRequest(request(method, path, GRANT));
        expect(matched, `${method} ${path}`).toBe(false);
      }
    });

    it('lets everything through with a valid access cookie, as before', async () => {
      for (const [method, path] of [...ROWS, ...NOT_EXEMPT, ...LOOK_ALIKES]) {
        for (const cookie of [accessCookie(), `${accessCookie()}; ${GRANT}`]) {
          expect(await outcome(method, path, cookie), `${method} ${path}`).toBe('passed');
        }
      }
    });

    describe('CSRF on the POST rows 6, 8 and 10 (D-O1-R8)', () => {
      it('applies to exactly rows 6, 8 and 10', () => {
        expect(POST_ROWS.map(([, path]) => path)).toEqual([
          `/api/stages/${S}/scene-regenerations/${CHILD}/restore`,
          `/api/stages/${S}/scenes/${CHILD}/regenerate`,
          `/api/stages/${S}/scenes/${CHILD}/narration-audio`,
        ]);
      });

      it('passes them with Sec-Fetch-Site: same-origin', async () => {
        for (const [method, path] of POST_ROWS) {
          expect(await outcome(method, path, GRANT, SAME_ORIGIN), `${method} ${path}`).toBe(
            'passed',
          );
        }
      });

      it('answers 401 to same-site, cross-site, none and no fetch headers', async () => {
        for (const [method, path] of POST_ROWS) {
          for (const [label, headers] of NOT_SAME_ORIGIN) {
            expect(await outcome(method, path, GRANT, headers), `${method} ${path} ${label}`).toBe(
              401,
            );
            expect(
              isEditorGrantExemptRequest(request(method, path, GRANT, headers)),
              `${method} ${path} ${label} (predicate)`,
            ).toBe(false);
          }
        }
      });

      it('without Sec-Fetch-Site, passes an Origin equal to the public origin', async () => {
        const matching: ReadonlyArray<Readonly<Record<string, string>>> = [
          { origin: 'http://te.test' },
          {
            origin: 'https://te.example:8443',
            'x-forwarded-host': 'te.example:8443',
            'x-forwarded-proto': 'https',
          },
          // No forwarded proto: http, as `requestOrigin` builds it.
          { origin: 'http://te.example', 'x-forwarded-host': 'te.example' },
        ];
        for (const [method, path] of POST_ROWS) {
          for (const headers of matching) {
            expect(
              await outcome(method, path, GRANT, headers),
              `${method} ${path} ${JSON.stringify(headers)}`,
            ).toBe('passed');
          }
        }
      });

      it('without Sec-Fetch-Site, answers 401 to a mismatching Origin', async () => {
        const mismatching: ReadonlyArray<Readonly<Record<string, string>>> = [
          { origin: 'http://te.test:8444' },
          { origin: 'https://te.test' },
          { origin: 'http://admin.test' },
          { origin: 'null' },
          { origin: '' },
          // The forwarded host wins over the URL's own origin.
          {
            origin: 'http://te.test',
            'x-forwarded-host': 'te.example',
            'x-forwarded-proto': 'https',
          },
          {
            origin: 'https://te.example:8444',
            'x-forwarded-host': 'te.example:8443',
            'x-forwarded-proto': 'https',
          },
          { origin: 'https://te.example', 'x-forwarded-host': 'te.example' },
        ];
        for (const [method, path] of POST_ROWS) {
          for (const headers of mismatching) {
            expect(
              await outcome(method, path, GRANT, headers),
              `${method} ${path} ${JSON.stringify(headers)}`,
            ).toBe(401);
          }
        }
      });

      it('leaves the GET, PUT and DELETE rows unaffected by fetch headers', async () => {
        for (const [method, path] of NON_POST_ROWS) {
          for (const [label, headers] of NOT_SAME_ORIGIN) {
            expect(await outcome(method, path, GRANT, headers), `${method} ${path} ${label}`).toBe(
              'passed',
            );
          }
          expect(
            await outcome(method, path, GRANT, { origin: 'http://admin.test' }),
            `${method} ${path} foreign Origin`,
          ).toBe('passed');
        }
        // The D-O1-1 media reads and the row-11 learner document read too.
        for (const [method, path] of [
          ['GET', `/api/classroom-media/${S}/media/figure.png`],
          ['GET', `/api/persistence/documents/${S}`],
        ] as const) {
          expect(
            await outcome(method, path, GRANT, { 'sec-fetch-site': 'cross-site' }),
            `${method} ${path}`,
          ).toBe('passed');
        }
      });

      it('lets a valid access cookie through cross-site, as before', async () => {
        for (const [method, path] of POST_ROWS) {
          for (const cookie of [accessCookie(), `${accessCookie()}; ${GRANT}`]) {
            for (const [label, headers] of NOT_SAME_ORIGIN) {
              expect(
                await outcome(method, path, cookie, headers),
                `${method} ${path} ${label}`,
              ).toBe('passed');
            }
          }
        }
      });

      it('still answers 401 without a grant cookie, whatever the fetch headers', async () => {
        for (const [method, path] of POST_ROWS) {
          expect(await outcome(method, path, undefined, SAME_ORIGIN), `${method} ${path}`).toBe(
            401,
          );
        }
      });
    });
  });

  describe('production with an empty ACCESS_CODE (closed mode)', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ACCESS_CODE', '');
    });

    it('still answers 503 on every row with a grant cookie', async () => {
      expect(
        await outcome('GET', `/api/classroom-media/${S}/media/figure.png`, GRANT),
        'unsigned classroom media with a grant cookie',
      ).toBe(503);
      for (const [method, path] of ROWS) {
        expect(await outcome(method, path, GRANT), `${method} ${path}`).toBe(503);
        expect(
          await outcome(method, path, `${accessCookie()}; ${GRANT}`),
          `${method} ${path} with access cookie`,
        ).toBe(503);
      }
    });

    it('still answers 503 on the POST rows whatever the fetch headers (D-O1-R8)', async () => {
      for (const [method, path] of POST_ROWS) {
        for (const [label, headers] of [
          ['same-origin', SAME_ORIGIN],
          ...NOT_SAME_ORIGIN,
        ] as const) {
          expect(await outcome(method, path, GRANT, headers), `${method} ${path} ${label}`).toBe(
            503,
          );
        }
      }
    });
  });
});

describe('editor-grant exemption table (structural pin)', () => {
  const API_DIR = join(__dirname, '..', '..', 'app', 'api');
  const ROOT_DIR = join(__dirname, '..', '..');

  it('equals the reviewed list', () => {
    expect(EDITOR_GRANT_EXEMPT_ROUTES).toEqual(REVIEWED);
    for (const [method] of EDITOR_GRANT_EXEMPT_ROUTES) {
      expect(['HEAD', 'OPTIONS']).not.toContain(method);
    }
  });

  it('lists only routes whose handler verifies the grant', () => {
    for (const [method, path] of EDITOR_GRANT_EXEMPT_ROUTES) {
      const isStageRoute = path in STAGE_ROUTE_FILES;
      const file = isStageRoute ? STAGE_ROUTE_FILES[path] : PERSISTENCE_ROUTE_FILE;
      expect(file, path).toBeDefined();
      const source = readFileSync(join(API_DIR, file), 'utf8');
      const label = `${method} ${path} (${file})`;
      expect(source, label).toMatch(new RegExp(`export (async function|const) ${method}\\b`));
      if (path === '/api/stage-meta/:id') {
        // D-O1-2: without the access cookie, the handler requires the tenant grant.
        expect(source, label).toMatch(/holdsTenantEditorGrant/);
      }
      if (isStageRoute) {
        expect(source, label).toMatch(/readEditorGrant|resolveRegenerationGrant/);
        if (method !== 'GET') {
          expect(source, label).toMatch(/capability !== 'write'|requireWrite: true/);
        }
      } else {
        expect(source, label).toMatch(/evaluateEditorGrant/);
        expect(source, label).toMatch(/GRANT_READ_ONLY/);
      }
    }
  });

  it('keeps the middleware Edge-safe (no Node or grant-crypto imports)', () => {
    for (const file of ['middleware.ts', 'lib/config/access-code-allowlist.ts']) {
      const source = readFileSync(join(ROOT_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/from ['"](node:|crypto['"]|fs['"]|path['"])/);
      expect(source, file).not.toMatch(/teaching-package\/editor-grant/);
    }
  });

  /**
   * Every route file outside the open prefixes, concretised with sample ids:
   * with only a grant cookie, a method passes only where the table lists it.
   */
  it('blocks every other route file in app/api with only a grant cookie', async () => {
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '');
    vi.stubEnv('ACCESS_CODE', CODE);
    const OPEN_FOLDERS = new Set([
      'access-code',
      'health',
      'teaching-model',
      'teaching-packages',
      'tutor',
    ]);
    const allowed = new Map<string, Set<string>>();
    for (const [method, path] of EDITOR_GRANT_EXEMPT_ROUTES) {
      const file = STAGE_ROUTE_FILES[path];
      if (!file) continue;
      allowed.set(file, (allowed.get(file) ?? new Set()).add(method));
    }

    function routeFiles(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return routeFiles(full);
        return name === 'route.ts' ? [full] : [];
      });
    }
    const concrete = (segment: string) => {
      if (segment.startsWith('[[...')) return 'a';
      if (segment.startsWith('[...')) return 'a/b';
      if (segment.startsWith('[')) return 'sample-id';
      return segment;
    };

    let checked = 0;
    try {
      for (const full of routeFiles(API_DIR)) {
        const file = relative(API_DIR, full).split(sep).join('/');
        const segments = file.split('/').slice(0, -1);
        if (OPEN_FOLDERS.has(segments[0])) continue;
        const path = `/api/${segments.map(concrete).join('/')}`;
        for (const method of METHODS) {
          const expected = allowed.get(file)?.has(method) ? 'passed' : 401;
          expect(await outcome(method, path, GRANT), `${method} ${path} (${file})`).toBe(expected);
          checked += 1;
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(checked).toBeGreaterThan(0);
    expect([...allowed.keys()].sort()).toEqual(Object.values(STAGE_ROUTE_FILES).sort());
  });
});
